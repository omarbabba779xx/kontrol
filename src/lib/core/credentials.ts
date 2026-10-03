import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Actor } from "@/lib/core/auth";
import { userError } from "@/lib/core/errors";
import { appendAudit } from "@/lib/core/integrity";
import { open, seal, sealedWithCurrentKey } from "@/lib/core/secrets";
import { assertPublicHttpsUrl } from "@/lib/core/net-guard";
import { getDb } from "@/lib/db";

/**
 * Connector credentials entered in the application. They are encrypted at rest (secrets.ts), never returned by any
 * API (only a four-character hint and the rotation date are), and used by the connectors in preference to environment variables.
 */
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

export const CREDENTIAL_SCHEMAS = {
  github: { primary: "token", schema: z.object({ token: z.string().min(20).max(400) }) },
  gitlab: {
    primary: "token",
    schema: z.object({
      baseUrl: httpsUrl.default("https://gitlab.com"),
      token: z.string().min(10).max(400),
      group: z.string().min(1).max(200).optional(),
    }),
  },
  okta: { primary: "token", schema: z.object({ baseUrl: httpsUrl, token: z.string().min(10).max(400) }) },
  aws: {
    primary: "secretAccessKey",
    schema: z.object({
      accessKeyId: z.string().min(16).max(128),
      secretAccessKey: z.string().min(20).max(256),
      sessionToken: z.string().max(4096).optional(),
      region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/),
    }),
  },
  google_workspace: {
    primary: "serviceAccountJson",
    schema: z.object({
      serviceAccountJson: z
        .string()
        .min(50)
        .max(20_000)
        .refine((value) => {
          try {
            const parsed = JSON.parse(value) as { client_email?: unknown; private_key?: unknown };
            return typeof parsed.client_email === "string" && typeof parsed.private_key === "string";
          } catch {
            return false;
          }
        }, "Must be a service-account key file (JSON with client_email and private_key)"),
      adminEmail: z.string().email(),
    }),
  },
  entra: {
    primary: "clientSecret",
    schema: z.object({ tenantId: z.string().uuid(), clientId: z.string().uuid(), clientSecret: z.string().min(10).max(400) }),
  },
} as const;

export type CredentialKind = keyof typeof CREDENTIAL_SCHEMAS;
export type CredentialValues<K extends CredentialKind> = z.infer<(typeof CREDENTIAL_SCHEMAS)[K]["schema"]>;
export const CREDENTIAL_KINDS = Object.keys(CREDENTIAL_SCHEMAS) as CredentialKind[];

const aad = (tenantId: string, kind: string) => `${tenantId}:${kind}`;

export async function saveCredentials(actor: Actor, kind: CredentialKind, input: unknown) {
  const definition = CREDENTIAL_SCHEMAS[kind];
  if (!definition) throw userError(`Unknown connector ${kind}`);
  const values = definition.schema.parse(input) as Record<string, unknown>;
  const secret = String(values[definition.primary]);
  const box = seal(JSON.stringify(values), aad(actor.tenantId, kind));
  const now = new Date().toISOString();
  await (await getDb()).scope(actor.tenantId).transaction(async (tx) => {
    await tx.run(
      `INSERT INTO connector_credentials (id,tenant_id,kind,ciphertext,iv,tag,key_version,hint,created_by,created_at,rotated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id, kind) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag, key_version = excluded.key_version, hint = excluded.hint, rotated_at = excluded.rotated_at`,
      `cred_${randomUUID()}`,
      actor.tenantId,
      kind,
      box.ciphertext,
      box.iv,
      box.tag,
      box.keyVersion,
      secret.slice(-4),
      actor.userId,
      now,
      now,
    );
    await appendAudit(
      {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "credentials.saved",
        objectType: "connector",
        objectId: kind,
        payload: { kind, hint: secret.slice(-4) },
      },
      tx,
    );
  });
  return { kind, hint: secret.slice(-4) };
}

export async function deleteCredentials(actor: Actor, kind: CredentialKind) {
  const db = (await getDb()).scope(actor.tenantId);
  await db.transaction(async (tx) => {
    const result = await tx.run("DELETE FROM connector_credentials WHERE tenant_id = ? AND kind = ?", actor.tenantId, kind);
    if (result.changes === 0) throw userError(`No credentials stored for ${kind}; nothing to delete (not found)`);
    await appendAudit(
      {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "credentials.deleted",
        objectType: "connector",
        objectId: kind,
        payload: { kind },
      },
      tx,
    );
  });
  return { kind };
}

/** Decrypts stored credentials, or returns null when none are stored. A key that no longer matches is reported, not ignored. */
export async function loadCredentials<K extends CredentialKind>(tenantId: string, kind: K): Promise<CredentialValues<K> | null> {
  const row = await (
    await getDb()
  )
    .scope(tenantId)
    .get<{ ciphertext: string; iv: string; tag: string }>(
      "SELECT ciphertext, iv, tag FROM connector_credentials WHERE tenant_id = ? AND kind = ?",
      tenantId,
      kind,
    );
  if (!row) return null;
  try {
    return JSON.parse(open(row, aad(tenantId, kind))) as CredentialValues<K>;
  } catch {
    throw userError(
      `Stored ${kind} credentials cannot be decrypted: KONTROL_SECRETS_KEY changed or the data was altered. Save the credentials again.`,
    );
  }
}

export async function credentialStatus(tenantId: string) {
  const rows = await (
    await getDb()
  )
    .scope(tenantId)
    .all<{ kind: string; hint: string; rotated_at: string }>(
      "SELECT kind, hint, rotated_at FROM connector_credentials WHERE tenant_id = ?",
      tenantId,
    );
  const byKind = new Map(rows.map((row) => [row.kind, row]));
  return CREDENTIAL_KINDS.map((kind) => ({
    kind,
    configured: byKind.has(kind),
    hint: byKind.get(kind)?.hint ?? null,
    rotatedAt: byKind.get(kind)?.rotated_at ?? null,
  }));
}

/** Re-seals every stored credential of the tenant with the current key. Returns how many needed it. */
export async function resealCredentials(actor: Actor) {
  const db = (await getDb()).scope(actor.tenantId);
  const rows = await db.all<{ kind: string; ciphertext: string; iv: string; tag: string }>(
    "SELECT kind, ciphertext, iv, tag FROM connector_credentials WHERE tenant_id = ?",
    actor.tenantId,
  );
  let resealed = 0,
    current = 0;
  const failed: string[] = [];
  for (const row of rows) {
    const context = aad(actor.tenantId, row.kind);
    if (sealedWithCurrentKey(row, context)) {
      current += 1;
      continue;
    }
    try {
      const box = seal(open(row, context), context);
      await db.run(
        "UPDATE connector_credentials SET ciphertext = ?, iv = ?, tag = ?, key_version = ? WHERE tenant_id = ? AND kind = ?",
        box.ciphertext,
        box.iv,
        box.tag,
        box.keyVersion,
        actor.tenantId,
        row.kind,
      );
      resealed += 1;
    } catch {
      failed.push(row.kind);
    }
  }
  return { resealed, alreadyCurrent: current, failed };
}
