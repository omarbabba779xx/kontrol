import "server-only";

import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { createTransport } from "nodemailer";
import { z } from "zod";
import type { Actor } from "@/lib/core/auth";
import { userError } from "@/lib/core/errors";
import { appendAudit } from "@/lib/core/integrity";
import { assertPublicHttpsUrl, assertResolvesPublic, safeFetch } from "@/lib/core/net-guard";
import { open, seal } from "@/lib/core/secrets";
import { getDb } from "@/lib/db";

/**
 * Notifications: events are written to an outbox per matching channel, then delivered with retries and back-off.
 * A channel's destination and credentials are encrypted at rest and never returned. Delivery refuses redirects and
 * private network targets, and error messages are scrubbed of URLs before they are stored.
 */
export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];
const rank = (severity: string) => SEVERITIES.indexOf(severity as Severity);

export const EVENT_TYPES = [
  "task.assigned",
  "task.overdue",
  "finding.opened",
  "exception.pending",
  "exception.expiring",
  "attestation.expired",
  "attestation.expiring",
  "evidence.pending_review",
  "policy.review_overdue",
  "connector.failing",
  "connector.recovered",
  "audit.request_due",
  "questionnaire.responded",
  "risk.review_due",
  "test",
] as const;

const httpsUrl = z
  .string()
  .url()
  .refine((value) => {
    try {
      assertPublicHttpsUrl(value);
      return true;
    } catch {
      return false;
    }
  }, "Must be a public https URL");

export const CHANNEL_SCHEMAS = {
  slack: z.object({ webhookUrl: httpsUrl }),
  webhook: z.object({ url: httpsUrl }),
  email: z.object({
    host: z.string().min(3).max(200),
    port: z.number().int().min(1).max(65535),
    secure: z.boolean().default(false),
    user: z.string().max(200).optional(),
    pass: z.string().max(400).optional(),
    from: z.string().email(),
    to: z.array(z.string().email()).min(1).max(20),
    includeAssignee: z.boolean().default(false),
  }),
  jira: z.object({
    baseUrl: httpsUrl,
    email: z.string().email(),
    apiToken: z.string().min(8).max(400),
    projectKey: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/),
    issueType: z.string().min(2).max(40).default("Task"),
  }),
} as const;
export type ChannelKind = keyof typeof CHANNEL_SCHEMAS;

const aad = (tenantId: string, channelId: string) => `${tenantId}:channel:${channelId}`;
const RETRY_MINUTES = [1, 5, 30, 120, 360];
const LEASE_MS = 5 * 60_000;

export type NotificationEvent = {
  type: string;
  severity: Severity;
  title: string;
  body: string;
  link?: string;
  dedupeKey: string;
  payload?: Record<string, unknown>;
};

type ChannelRow = {
  id: string;
  tenant_id: string;
  kind: ChannelKind;
  name: string;
  events_json: string;
  min_severity: Severity;
  enabled: number;
  ciphertext: string;
  iv: string;
  tag: string;
  hint: string;
  last_status: string | null;
  last_error: string | null;
  last_sent_at: string | null;
  created_at: string;
};

const scrub = (message: string) =>
  message
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/(token|secret|password|authorization|bearer)[=:\s]+\S+/gi, "$1 [redacted]")
    .slice(0, 300);

function hintOf(kind: ChannelKind, config: Record<string, unknown>) {
  if (kind === "slack") return new URL(String(config.webhookUrl)).hostname;
  if (kind === "webhook") return new URL(String(config.url)).hostname;
  if (kind === "email")
    return `${(config.to as string[])[0]}${(config.to as string[]).length > 1 ? ` +${(config.to as string[]).length - 1}` : ""}`;
  return `${new URL(String(config.baseUrl)).hostname} / ${String(config.projectKey)}`;
}

export async function createChannel(
  actor: Actor,
  input: { kind: ChannelKind; name: string; config: unknown; events: string[]; minSeverity: Severity },
) {
  const schema = CHANNEL_SCHEMAS[input.kind];
  if (!schema) throw userError(`Unsupported channel ${input.kind}`);
  for (const event of input.events)
    if (event !== "*" && !(EVENT_TYPES as readonly string[]).includes(event)) throw userError(`Unknown event ${event}`);
  const config = schema.parse(input.config) as Record<string, unknown>;
  const signingSecret = input.kind === "webhook" ? randomBytes(32).toString("hex") : undefined;
  const id = `chan_${randomUUID()}`;
  const box = seal(JSON.stringify(signingSecret ? { ...config, signingSecret } : config), aad(actor.tenantId, id));
  await (await getDb()).scope(actor.tenantId).transaction(async (tx) => {
    await tx.run(
      "INSERT INTO notification_channels (id,tenant_id,kind,name,events_json,min_severity,enabled,ciphertext,iv,tag,hint,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id,
      actor.tenantId,
      input.kind,
      input.name.trim(),
      JSON.stringify(input.events.length ? input.events : ["*"]),
      input.minSeverity,
      1,
      box.ciphertext,
      box.iv,
      box.tag,
      hintOf(input.kind, config),
      actor.userId,
      new Date().toISOString(),
    );
    await appendAudit(
      {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "notifications.channel_created",
        objectType: "notification_channel",
        objectId: id,
        payload: { kind: input.kind, name: input.name, events: input.events, minSeverity: input.minSeverity },
      },
      tx,
    );
  });
  return { id, signingSecret };
}

export async function listChannels(tenantId: string) {
  const db = (await getDb()).scope(tenantId);
  const channels = await db.all<ChannelRow>(
    "SELECT id, kind, name, events_json, min_severity, enabled, hint, last_status, last_error, last_sent_at, created_at FROM notification_channels WHERE tenant_id = ? ORDER BY created_at",
    tenantId,
  );
  const outbox = await db.all<{
    id: string;
    channel_id: string;
    event_type: string;
    severity: string;
    title: string;
    status: string;
    attempts: number;
    last_error: string | null;
    created_at: string;
    sent_at: string | null;
  }>(
    "SELECT id, channel_id, event_type, severity, title, status, attempts, last_error, created_at, sent_at FROM notifications WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 40",
    tenantId,
  );
  return {
    channels: channels.map((row) => ({
      id: row.id,
      kind: row.kind,
      name: row.name,
      events: JSON.parse(row.events_json) as string[],
      minSeverity: row.min_severity,
      enabled: row.enabled === 1,
      hint: row.hint,
      lastStatus: row.last_status,
      lastError: row.last_error,
      lastSentAt: row.last_sent_at,
    })),
    outbox,
    events: EVENT_TYPES,
  };
}

export async function setChannelEnabled(actor: Actor, input: { id: string; enabled: boolean }) {
  const result = await (
    await getDb()
  )
    .scope(actor.tenantId)
    .run("UPDATE notification_channels SET enabled = ? WHERE tenant_id = ? AND id = ?", input.enabled ? 1 : 0, actor.tenantId, input.id);
  if (result.changes !== 1) throw userError("Channel not found");
  return input;
}

export async function deleteChannel(actor: Actor, id: string) {
  await (await getDb()).scope(actor.tenantId).transaction(async (tx) => {
    if (!(await tx.get("SELECT id FROM notification_channels WHERE tenant_id = ? AND id = ?", actor.tenantId, id)))
      throw userError("Channel not found");
    await tx.run("DELETE FROM notifications WHERE tenant_id = ? AND channel_id = ?", actor.tenantId, id);
    await tx.run("DELETE FROM notification_channels WHERE tenant_id = ? AND id = ?", actor.tenantId, id);
    await appendAudit(
      {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "notifications.channel_deleted",
        objectType: "notification_channel",
        objectId: id,
        payload: {},
      },
      tx,
    );
  });
  return { id };
}

/** Queues the event for every enabled channel that subscribes to it at this severity. Repeats with the same key are ignored. */
export async function notify(tenantId: string, event: NotificationEvent) {
  const db = (await getDb()).scope(tenantId);
  const channels = await db.all<{ id: string; events_json: string; min_severity: Severity }>(
    "SELECT id, events_json, min_severity FROM notification_channels WHERE tenant_id = ? AND enabled = 1",
    tenantId,
  );
  let queued = 0;
  const now = new Date().toISOString();
  for (const channel of channels) {
    const events = JSON.parse(channel.events_json) as string[];
    if (!(events.includes("*") || events.includes(event.type))) continue;
    if (rank(event.severity) < rank(channel.min_severity)) continue;
    const result = await db.run(
      `INSERT INTO notifications (id,tenant_id,channel_id,event_type,severity,title,body,link,payload_json,dedupe_key,status,attempts,next_attempt_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id, channel_id, dedupe_key) DO NOTHING`,
      `ntf_${randomUUID()}`,
      tenantId,
      channel.id,
      event.type,
      event.severity,
      event.title.slice(0, 300),
      event.body.slice(0, 4000),
      event.link ?? null,
      JSON.stringify(event.payload ?? {}),
      event.dedupeKey,
      "pending",
      0,
      now,
      now,
    );
    queued += result.changes;
  }
  return queued;
}

// ---------------------------------------------------------------- Delivery -------------------------------------------------

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; redirect: "error"; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;
type Mail = { from: string; to: string[]; subject: string; text: string };
export type DeliveryDeps = {
  fetchImpl?: FetchLike;
  /** Resolves the destination host and refuses private addresses. Tests replace it. */
  guard?: (url: string) => Promise<unknown>;
  sendMail?: (smtp: Record<string, unknown>, mail: Mail) => Promise<void>;
  now?: number;
};

const defaultFetch: FetchLike = (url, init) =>
  safeFetch(url, {
    method: init?.method,
    headers: init?.headers as Record<string, string> | undefined,
    body: init?.body as string | undefined,
    signal: init?.signal ?? undefined,
  });
const defaultMail = async (smtp: Record<string, unknown>, mail: Mail) => {
  const transport = createTransport({
    host: String(smtp.host),
    port: Number(smtp.port),
    secure: smtp.secure === true,
    auth: smtp.user ? { user: String(smtp.user), pass: String(smtp.pass ?? "") } : undefined,
    connectionTimeout: 10_000,
    socketTimeout: 15_000,
  });
  await transport.sendMail(mail);
};

type Delivered = {
  id: string;
  tenant_id: string;
  channel_id: string;
  event_type: string;
  severity: string;
  title: string;
  body: string;
  link: string | null;
  payload_json: string;
  created_at: string;
  attempts: number;
};

async function deliverOne(
  row: Delivered,
  channel: ChannelRow,
  secret: Record<string, unknown>,
  deps: Required<Pick<DeliveryDeps, "fetchImpl" | "guard" | "sendMail">>,
) {
  const text = `${row.title}\n${row.body}${row.link ? `\n${row.link}` : ""}`;
  const post = async (url: string, headers: Record<string, string>, body: string) => {
    await deps.guard(url);
    const response = await deps.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`${channel.kind} answered ${response.status}`);
  };
  switch (channel.kind) {
    case "slack":
      return post(
        String(secret.webhookUrl),
        {},
        JSON.stringify({ text: `*${row.title}*\n${row.body}${row.link ? `\n<${row.link}|Open in Kontrol>` : ""}` }),
      );
    case "webhook": {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const body = JSON.stringify({
        id: row.id,
        tenantId: row.tenant_id,
        event: row.event_type,
        severity: row.severity,
        title: row.title,
        body: row.body,
        link: row.link,
        payload: JSON.parse(row.payload_json) as unknown,
        createdAt: row.created_at,
      });
      return post(
        String(secret.url),
        {
          "X-Kontrol-Timestamp": timestamp,
          "X-Kontrol-Signature": `sha256=${createHmac("sha256", String(secret.signingSecret)).update(`${timestamp}.${body}`).digest("hex")}`,
        },
        body,
      );
    }
    case "email": {
      const payload = JSON.parse(row.payload_json) as { assigneeEmail?: string };
      const to = [...(secret.to as string[]), ...(secret.includeAssignee === true && payload.assigneeEmail ? [payload.assigneeEmail] : [])];
      return deps.sendMail(secret, {
        from: String(secret.from),
        to: [...new Set(to)],
        subject: `[Kontrol ${row.severity}] ${row.title}`,
        text,
      });
    }
    case "jira": {
      const base = String(secret.baseUrl).replace(/\/$/, "");
      const auth = Buffer.from(`${String(secret.email)}:${String(secret.apiToken)}`).toString("base64");
      return post(
        `${base}/rest/api/3/issue`,
        { Authorization: `Basic ${auth}` },
        JSON.stringify({
          fields: {
            project: { key: secret.projectKey },
            summary: row.title.slice(0, 250),
            issuetype: { name: secret.issueType ?? "Task" },
            description: {
              type: "doc",
              version: 1,
              content: [{ type: "paragraph", content: [{ type: "text", text: text.slice(0, 30_000) }] }],
            },
          },
        }),
      );
    }
  }
}

/** Delivers due notifications, oldest first. A row is leased before sending so two instances cannot both send it. */
export async function deliverPending(options: DeliveryDeps & { limit?: number } = {}) {
  const now = options.now ?? Date.now();
  const deps = {
    fetchImpl: options.fetchImpl ?? defaultFetch,
    guard: options.guard ?? assertResolvesPublic,
    sendMail: options.sendMail ?? defaultMail,
  };
  const db = (await getDb()).system();
  const due = await db.all<Delivered>(
    "SELECT id, tenant_id, channel_id, event_type, severity, title, body, link, payload_json, created_at, attempts FROM notifications WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?",
    new Date(now).toISOString(),
    options.limit ?? 50,
  );
  const results: Array<{ id: string; status: "sent" | "failed" | "dead" }> = [];
  for (const row of due) {
    const lease = await db.run(
      "UPDATE notifications SET next_attempt_at = ? WHERE id = ? AND status = 'pending' AND next_attempt_at <= ?",
      new Date(now + LEASE_MS).toISOString(),
      row.id,
      new Date(now).toISOString(),
    );
    if (lease.changes !== 1) continue;
    const channel = await db.get<ChannelRow>("SELECT * FROM notification_channels WHERE id = ?", row.channel_id);
    let error: string | null = null;
    try {
      if (!channel) throw new Error("The channel no longer exists");
      if (channel.enabled !== 1) throw new Error("The channel is disabled");
      await deliverOne(row, channel, JSON.parse(open(channel, aad(row.tenant_id, channel.id))) as Record<string, unknown>, deps);
    } catch (caught) {
      error = scrub(caught instanceof Error ? caught.message : String(caught));
    }
    const finished = new Date().toISOString();
    if (!error) {
      await db.run(
        "UPDATE notifications SET status = 'sent', attempts = ?, sent_at = ?, last_error = NULL WHERE id = ?",
        row.attempts + 1,
        finished,
        row.id,
      );
      await db.run(
        "UPDATE notification_channels SET last_status = 'ok', last_error = NULL, last_sent_at = ? WHERE id = ?",
        finished,
        row.channel_id,
      );
      results.push({ id: row.id, status: "sent" });
    } else {
      const attempts = row.attempts + 1;
      const dead = attempts >= RETRY_MINUTES.length;
      await db.run(
        "UPDATE notifications SET status = ?, attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?",
        dead ? "dead" : "pending",
        attempts,
        error,
        new Date(now + RETRY_MINUTES[Math.min(attempts - 1, RETRY_MINUTES.length - 1)] * 60_000).toISOString(),
        row.id,
      );
      await db.run("UPDATE notification_channels SET last_status = 'failing', last_error = ? WHERE id = ?", error, row.channel_id);
      results.push({ id: row.id, status: dead ? "dead" : "failed" });
    }
  }
  return results;
}

/** Sends a test message to one channel immediately and reports the outcome. */
export async function testChannel(actor: Actor, channelId: string, deps: DeliveryDeps = {}) {
  const db = (await getDb()).scope(actor.tenantId);
  const channel = await db.get<ChannelRow>(
    "SELECT id FROM notification_channels WHERE tenant_id = ? AND id = ?",
    actor.tenantId,
    channelId,
  );
  if (!channel) throw userError("Channel not found");
  const id = `ntf_${randomUUID()}`;
  const now = new Date().toISOString();
  await db.run(
    "INSERT INTO notifications (id,tenant_id,channel_id,event_type,severity,title,body,payload_json,dedupe_key,status,attempts,next_attempt_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    id,
    actor.tenantId,
    channelId,
    "test",
    "low",
    "Kontrol test notification",
    `Sent by ${actor.name}. If you can read this, the channel works.`,
    "{}",
    `test:${id}`,
    "pending",
    RETRY_MINUTES.length - 1,
    now,
    now,
  );
  await deliverPending({ ...deps, limit: 200 });
  const row = await db.get<{ status: string; last_error: string | null }>("SELECT status, last_error FROM notifications WHERE id = ?", id);
  return { ok: row?.status === "sent", detail: row?.status === "sent" ? "Delivered." : (row?.last_error ?? "Not delivered.") };
}

/** Puts a dead notification back in the queue. */
export async function retryNotification(actor: Actor, id: string) {
  const result = await (
    await getDb()
  )
    .scope(actor.tenantId)
    .run(
      "UPDATE notifications SET status = 'pending', attempts = 0, next_attempt_at = ? WHERE tenant_id = ? AND id = ? AND status IN ('dead','failed')",
      new Date().toISOString(),
      actor.tenantId,
      id,
    );
  if (result.changes !== 1) throw userError("Notification not found or not retryable");
  return { id };
}
