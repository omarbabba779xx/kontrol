"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { Bell, CalendarClock, Copy, KeyRound, Plug, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { MicroLabel, PageHeading } from "@/components/platform-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { errorMessage, fetchJson, isAbort } from "@/components/api-client";

type Role = "admin" | "risk_owner" | "control_owner" | "auditor" | "viewer";
type User = { id: string; email: string; name: string; role: Role; status: "active" | "disabled"; created_at: string; last_login_at: string | null };
type ApiKey = { id: string; name: string; prefix: string; role: Role; created_at: string; expires_at: string | null; last_used_at: string | null; revoked_at: string | null; active: boolean };
type Credential = { kind: string; configured: boolean; hint: string | null; rotatedAt: string | null };
type Snapshot = { users: User[]; apiKeys: ApiKey[]; credentials: Credential[]; authentication: { oidc: boolean; oidcRoleClaimTrusted: boolean; demoSessions: boolean; secretsKeyConfigured: boolean; ingestConfigured: boolean } };

const tabs = ["Users", "API keys", "Connections", "Notifications", "Authentication"] as const;
type Tab = (typeof tabs)[number];
const ROLES: Role[] = ["admin", "risk_owner", "control_owner", "auditor", "viewer"];
const ROLE_HELP: Record<Role, string> = { admin: "Everything, including users and credentials", risk_owner: "Simulates risk, approves decisions and reviews", control_owner: "Evaluates controls, uploads evidence, syncs connectors", auditor: "Read-only access with exports", viewer: "Read-only" };
const field = "h-8 rounded-none border-[#cbc7bd] bg-transparent text-[12px] shadow-none placeholder:text-[#63615a]";
const select = "h-8 border border-[#cbc7bd] bg-transparent px-2 text-[12px] focus-visible:outline-2 focus-visible:outline-[#171713]";

type FieldSpec = { name: string; label: string; secret?: boolean; textarea?: boolean; optional?: boolean; placeholder?: string };
const CONNECTORS: Record<string, { title: string; help: string; fields: FieldSpec[] }> = {
  github: { title: "GitHub", help: "Fine-grained token with read access to Administration and Metadata on the repositories you monitor.", fields: [{ name: "token", label: "Access token", secret: true }] },
  gitlab: { title: "GitLab", help: "Personal or group access token with read_api. Self-managed instances: set the base URL.", fields: [{ name: "baseUrl", label: "Base URL", placeholder: "https://gitlab.com", optional: true }, { name: "token", label: "Access token", secret: true }, { name: "group", label: "Group path", optional: true }] },
  okta: { title: "Okta", help: "API token with read access to users, roles and policies.", fields: [{ name: "baseUrl", label: "Organisation URL", placeholder: "https://your-org.okta.com" }, { name: "token", label: "API token", secret: true }] },
  aws: { title: "AWS", help: "Read-only credentials (IAM, S3 public access block, Config, CloudTrail). Use a dedicated role.", fields: [{ name: "accessKeyId", label: "Access key id" }, { name: "secretAccessKey", label: "Secret access key", secret: true }, { name: "sessionToken", label: "Session token", secret: true, optional: true }, { name: "region", label: "Region", placeholder: "eu-west-1" }] },
  google_workspace: { title: "Google Workspace", help: "Service-account key with domain-wide delegation, and the administrator it impersonates. Reads users, 2-Step Verification and admin roles.", fields: [{ name: "serviceAccountJson", label: "Service-account key (JSON)", secret: true, textarea: true }, { name: "adminEmail", label: "Delegated administrator email" }] },
  entra: { title: "Microsoft Entra ID", help: "App registration with application permissions to read users, roles and sign-in methods.", fields: [{ name: "tenantId", label: "Directory (tenant) id" }, { name: "clientId", label: "Application (client) id" }, { name: "clientSecret", label: "Client secret", secret: true }] },
};

export function AdminConsole() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [tab, setTab] = useState<Tab>("Users");
  const [status, setStatus] = useState("Loading…");
  const [failed, setFailed] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const load = useCallback((signal?: AbortSignal) => fetchJson<Snapshot>("/api/admin", { signal }).then((next) => { setSnapshot(next); setFailed(false); }), []);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).then(() => setStatus("Up to date")).catch((error: unknown) => { if (!isAbort(error)) { setFailed(true); setStatus(errorMessage(error, "Administration unavailable")); } });
    return () => controller.abort();
  }, [load]);

  function act(body: Record<string, unknown>, success: string, after?: (result: Record<string, unknown>) => void) {
    startTransition(async () => {
      let result: Record<string, unknown> = {};
      try { setStatus("Saving…"); result = await fetchJson<Record<string, unknown>>("/api/admin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
      catch (error) { setStatus(errorMessage(error, "Action failed")); return; }
      try { await load(); setStatus(success); after?.(result); } catch (error) { setStatus(`Done, but refresh failed: ${errorMessage(error, "unknown error")}`); }
    });
  }

  return (
    <div>
      <PageHeading index="13" title="Administration" description="People, access, API keys and the credentials that connect Kontrol to your systems." meta={status} />
      <section className="p-5 sm:p-7 lg:p-9" aria-busy={snapshot === null && !failed}>
        {failed ? <div role="alert" className="mb-4 border border-[#b8322a] bg-[#f5e5e1] p-3 text-[11px] text-[#9f2923]">{status}. Administration requires the administrator role.</div> : null}
        <div role="tablist" aria-label="Administration sections" className="mb-6 flex flex-wrap border-b border-[#cbc7bd]">
          {tabs.map((name) => <button key={name} role="tab" aria-selected={tab === name} type="button" onClick={() => setTab(name)} className={cn("px-4 py-2.5 text-[12px] font-medium", tab === name ? "border-b-2 border-[#171713] text-[#171713]" : "text-[#5f5d56] hover:text-[#171713]")}>{name}</button>)}
        </div>
        {snapshot && tab === "Users" ? <Users snapshot={snapshot} act={act} pending={isPending} /> : null}
        {snapshot && tab === "API keys" ? <Keys snapshot={snapshot} act={act} pending={isPending} newKey={newKey} setNewKey={setNewKey} /> : null}
        {snapshot && tab === "Connections" ? <Connections snapshot={snapshot} act={act} pending={isPending} /> : null}
        {snapshot && tab === "Notifications" ? <Notifications pending={isPending} /> : null}
        {snapshot && tab === "Authentication" ? <Authentication snapshot={snapshot} /> : null}
        {!snapshot && !failed ? <div className="grid min-h-40 place-items-center text-[11px] text-[#63615a]">Loading…</div> : null}
      </section>
    </div>
  );
}

type Act = (body: Record<string, unknown>, success: string, after?: (result: Record<string, unknown>) => void) => void;
const day = (value: string | null) => (value ? value.slice(0, 10) : "never");

function Users({ snapshot, act, pending }: { snapshot: Snapshot; act: Act; pending: boolean }) {
  const [form, setForm] = useState({ email: "", name: "", role: "viewer" as Role, external: false });
  return (
    <div className="grid gap-8 xl:grid-cols-[320px_1fr]">
      <form className="space-y-2 border border-[#cbc7bd] p-4" onSubmit={(event) => { event.preventDefault(); act({ action: "invite_user", ...form }, "User created", () => setForm({ email: "", name: "", role: "viewer", external: false })); }}>
        <MicroLabel>Add a user</MicroLabel>
        <Input aria-label="Full name" placeholder="Full name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} className={field} />
        <Input aria-label="Email" type="email" placeholder="Email (matches their single sign-on identity)" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} className={field} />
        <select aria-label="Role" value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value as Role })} className={cn(select, "w-full")}>{ROLES.map((role) => <option key={role} value={role}>{role.replace("_", " ")}</option>)}</select>
        <p className="text-[10px] text-[#5f5d56]">{ROLE_HELP[form.role]}</p>
        <label className="flex items-center gap-2 text-[11px]"><input type="checkbox" checked={form.external} onChange={(event) => setForm({ ...form, external: event.target.checked })} />External auditor (sees only the audit engagements granted to them)</label>
        <Button type="submit" disabled={pending || form.name.trim().length < 2 || !form.email.includes("@")} className="h-8 w-full rounded-none bg-[#171713] text-[12px] text-white"><UserPlus className="me-1.5 h-3 w-3" aria-hidden="true" />Add user</Button>
        <p className="text-[10px] text-[#5f5d56]">Sign-in is through your identity provider; the role set here applies when they first sign in.</p>
      </form>
      <div tabIndex={0} role="region" aria-label="Users table, scrollable" className="overflow-x-auto border border-[#cbc7bd] focus-visible:outline-2 focus-visible:outline-[#171713]"><table className="w-full min-w-[640px] text-left text-[11px]"><caption className="sr-only">Users</caption>
        <thead><tr className="bg-[#e9e5db] font-mono text-[10px] uppercase tracking-wider text-[#5f5d56]">{["User", "Role", "Status", "Last sign-in", ""].map((h) => <th key={h} scope="col" className="px-3 py-2.5">{h}</th>)}</tr></thead>
        <tbody>{snapshot.users.map((user) => (
          <tr key={user.id} className="border-t border-[#d8d4ca]">
            <td className="px-3 py-3"><span className="block font-medium">{user.name}</span><span className="font-mono text-[10px] text-[#5f5d56]">{user.email}</span></td>
            <td className="px-3 py-3"><select aria-label={`Role of ${user.email}`} value={user.role} disabled={pending} onChange={(event) => act({ action: "set_role", userId: user.id, role: event.target.value }, "Role updated")} className={select}>{ROLES.map((role) => <option key={role} value={role}>{role.replace("_", " ")}</option>)}</select></td>
            <td className="px-3 py-3 font-mono uppercase">{user.status}</td>
            <td className="px-3 py-3 font-mono">{day(user.last_login_at)}</td>
            <td className="px-3 py-3 text-end"><Button type="button" variant="outline" disabled={pending} onClick={() => act({ action: "set_status", userId: user.id, status: user.status === "active" ? "disabled" : "active" }, user.status === "active" ? "User disabled" : "User enabled")} className="h-7 rounded-none border-[#171713] bg-transparent text-[10px]">{user.status === "active" ? "Disable" : "Enable"}</Button></td>
          </tr>))}</tbody></table></div>
    </div>
  );
}

function Keys({ snapshot, act, pending, newKey, setNewKey }: { snapshot: Snapshot; act: Act; pending: boolean; newKey: string | null; setNewKey: (value: string | null) => void }) {
  const [form, setForm] = useState({ name: "", role: "viewer" as Role, expiresInDays: 90 });
  return (
    <div className="space-y-6">
      {newKey ? <div role="status" className="border border-[#245c3f] bg-[#dcebe1] p-4 text-[12px] text-[#173d2a]"><p className="font-semibold">Copy this key now. It is shown once and cannot be recovered.</p><div className="mt-2 flex flex-wrap items-center gap-2"><code className="break-all bg-white px-2 py-1 font-mono text-[12px]">{newKey}</code><Button type="button" variant="outline" onClick={() => void navigator.clipboard?.writeText(newKey)} className="h-7 rounded-none border-[#245c3f] bg-transparent text-[11px] text-[#245c3f]"><Copy className="me-1 h-3 w-3" aria-hidden="true" />Copy</Button><Button type="button" variant="ghost" onClick={() => setNewKey(null)} className="h-7 rounded-none text-[11px]">I have saved it</Button></div><p className="mt-2 text-[11px]">Use it as <code className="font-mono">Authorization: Bearer …</code>. It acts as you, with the role below, and stops working when it expires, is revoked, or you are disabled.</p></div> : null}
      <div className="grid gap-8 xl:grid-cols-[320px_1fr]">
        <form className="space-y-2 border border-[#cbc7bd] p-4" onSubmit={(event) => { event.preventDefault(); act({ action: "create_api_key", ...form }, "API key created", (result) => setNewKey(String(result.token ?? ""))); }}>
          <MicroLabel>Create an API key</MicroLabel>
          <Input aria-label="Key name" placeholder="Name (for example CI pipeline)" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} className={field} />
          <select aria-label="Key role" value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value as Role })} className={cn(select, "w-full")}>{ROLES.filter((role) => role !== "admin").map((role) => <option key={role} value={role}>{role.replace("_", " ")}</option>)}</select>
          <select aria-label="Key lifetime" value={form.expiresInDays} onChange={(event) => setForm({ ...form, expiresInDays: Number(event.target.value) })} className={cn(select, "w-full")}>{[7, 30, 90, 180, 365].map((days) => <option key={days} value={days}>Expires in {days} days</option>)}</select>
          <Button type="submit" disabled={pending || form.name.trim().length < 3} className="h-8 w-full rounded-none bg-[#171713] text-[12px] text-white"><KeyRound className="me-1.5 h-3 w-3" aria-hidden="true" />Create key</Button>
          <p className="text-[10px] text-[#5f5d56]">Keys can never be administrators.</p>
        </form>
        <div tabIndex={0} role="region" aria-label="API keys table, scrollable" className="overflow-x-auto border border-[#cbc7bd] focus-visible:outline-2 focus-visible:outline-[#171713]"><table className="w-full min-w-[640px] text-left text-[11px]"><caption className="sr-only">API keys</caption>
          <thead><tr className="bg-[#e9e5db] font-mono text-[10px] uppercase tracking-wider text-[#5f5d56]">{["Name", "Key", "Role", "Expires", "Last used", ""].map((h) => <th key={h} scope="col" className="px-3 py-2.5">{h}</th>)}</tr></thead>
          <tbody>{snapshot.apiKeys.map((key) => (
            <tr key={key.id} className="border-t border-[#d8d4ca]"><td className="px-3 py-3 font-medium">{key.name}</td><td className="px-3 py-3 font-mono">{key.prefix}…</td><td className="px-3 py-3">{key.role.replace("_", " ")}</td>
              <td className="px-3 py-3 font-mono">{key.revoked_at ? "revoked" : day(key.expires_at)}</td><td className="px-3 py-3 font-mono">{day(key.last_used_at)}</td>
              <td className="px-3 py-3 text-end">{key.active ? <Button type="button" variant="outline" disabled={pending} onClick={() => act({ action: "revoke_api_key", keyId: key.id }, "API key revoked")} className="h-7 rounded-none border-[#b8322a] bg-transparent text-[10px] text-[#b8322a]">Revoke</Button> : <span className="font-mono text-[10px] text-[#5f5d56]">inactive</span>}</td></tr>))}</tbody></table>
          {snapshot.apiKeys.length === 0 ? <p className="p-6 text-[12px] text-[#5f5d56]">No API keys yet.</p> : null}</div>
      </div>
    </div>
  );
}

type Schedule = { id: string; kind: string; target: string; intervalMinutes: number; enabled: boolean; nextRunAt: string; lastRunAt: string | null; lastStatus: string | null; lastError: string | null; consecutiveFailures: number; failing: boolean };
type RunRecord = { id: string; kind: string; target: string; trigger: string; started_at: string; status: string; error: string | null };
const INTERVALS: Array<[number, string]> = [[0, "Off"], [60, "Every hour"], [360, "Every 6 hours"], [1440, "Daily"], [10080, "Weekly"]];
const TARGETED: Record<string, string> = { github: "owner/repository", gitlab: "group/project" };

function Connections({ snapshot, act, pending }: { snapshot: Snapshot; act: Act; pending: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [tests, setTests] = useState<Record<string, { ok: boolean; detail: string }>>({});
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [busy, startBusy] = useTransition();
  const noKey = !snapshot.authentication.secretsKeyConfigured;

  const loadSchedules = useCallback(() => fetchJson<{ schedules: Schedule[]; runs: RunRecord[] }>("/api/schedules").then((data) => { setSchedules(data.schedules); setRuns(data.runs); }).catch(() => undefined), []);
  useEffect(() => { void loadSchedules(); }, [loadSchedules]);

  const post = (url: string, body: Record<string, unknown>, success: string, after?: (result: Record<string, unknown>) => void) => startBusy(async () => {
    try { setMessage("Working…"); const result = await fetchJson<Record<string, unknown>>(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); await loadSchedules(); setMessage(success); after?.(result); }
    catch (error) { setMessage(errorMessage(error, "Action failed")); }
  });

  function saveSchedule(kind: string, minutes: number) {
    const typedTarget = normalizeTarget(targets[kind] ?? "");
    const existing = schedules.find((item) => item.kind === kind && (!TARGETED[kind] || item.target === typedTarget || !typedTarget));
    if (minutes === 0) { if (existing) post("/api/schedules", { action: "save", kind, params: paramsFor(kind, existing.target), intervalMinutes: existing.intervalMinutes, enabled: false }, "Schedule turned off"); return; }
    const target = normalizeTarget(targets[kind] ?? existing?.target ?? "");
    if (TARGETED[kind] && !target.includes("/")) { setMessage(`Enter the target as ${TARGETED[kind]} first`); return; }
    post("/api/schedules", { action: "save", kind, params: paramsFor(kind, target), intervalMinutes: minutes, enabled: true }, "Schedule saved");
  }

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-[12px] text-[#55534b]"><Plug className="me-1 inline h-3 w-3" aria-hidden="true" />Credentials entered here are encrypted at rest (AES-256-GCM, bound to your tenant and the connector) and are never shown again: only the last four characters. They are used instead of environment variables.{noKey ? " KONTROL_SECRETS_KEY is not set: a development key is in use. Set a unique key before storing real credentials." : ""}</p>
      {message ? <p role="status" className="text-[11px] font-medium text-[#34332e]">{message}</p> : null}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {snapshot.credentials.map((item) => {
          const spec = CONNECTORS[item.kind];
          if (!spec) return null;
          const mine = schedules.filter((entry) => entry.kind === item.kind);
          // For connectors with a target, the schedule shown is the one for the target typed in the field; a new target has none yet.
          const typed = TARGETED[item.kind] ? normalizeTarget(targets[item.kind] ?? "") : "";
          const current = typed ? mine.find((entry) => entry.target === typed) : mine[0];
          const newTarget = TARGETED[item.kind] && typed !== "" && !current;
          const test = tests[item.kind];
          return (
            <div key={item.kind} className="border border-[#cbc7bd] bg-[#f8f6f0] p-4">
              <div className="flex items-start justify-between gap-2"><p className="text-[14px] font-semibold">{spec.title}</p><span className={cn("px-1.5 py-0.5 font-mono text-[10px] uppercase", item.configured ? "bg-[#dcebe1] text-[#245c3f]" : "bg-[#e5e2d8] text-[#5f5d56]")}>{item.configured ? `configured …${item.hint}` : "not configured"}</span></div>
              <p className="mt-1 text-[11px] text-[#55534b]">{spec.help}</p>
              {item.configured ? <p className="mt-1 font-mono text-[10px] text-[#5f5d56]">Updated {day(item.rotatedAt)}</p> : null}
              <div className="mt-3 flex flex-wrap gap-2"><Button type="button" variant="outline" aria-expanded={open === item.kind} onClick={() => { setOpen(open === item.kind ? null : item.kind); setValues({}); }} className="h-7 rounded-none border-[#171713] bg-transparent text-[11px]">{item.configured ? "Replace" : "Configure"}</Button>
                <Button type="button" variant="outline" disabled={busy || pending} onClick={() => post(`/api/connectors/${item.kind}/test`, {}, "Connection tested", (result) => setTests({ ...tests, [item.kind]: result as { ok: boolean; detail: string } }))} className="h-7 rounded-none border-[#171713] bg-transparent text-[11px]">Test connection</Button>
                {item.configured ? <Button type="button" variant="outline" disabled={pending} onClick={() => { if (window.confirm(`Remove the stored ${spec.title} credentials?`)) act({ action: "delete_credentials", kind: item.kind }, `${spec.title} credentials removed`); }} className="h-7 rounded-none border-[#b8322a] bg-transparent text-[11px] text-[#b8322a]"><Trash2 className="me-1 h-3 w-3" aria-hidden="true" />Remove</Button> : null}</div>
              {test ? <p role="status" className={cn("mt-2 border-s-2 ps-2 text-[11px]", test.ok ? "border-[#245c3f] text-[#245c3f]" : "border-[#b8322a] text-[#9f2923]")}>{test.ok ? "OK: " : "Failed: "}{test.detail}</p> : null}
              {open === item.kind ? <form className="mt-3 space-y-2" onSubmit={(event) => { event.preventDefault(); const payload = Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim() !== "")); act({ action: "save_credentials", kind: item.kind, values: payload }, `${spec.title} credentials saved`, () => { setOpen(null); setValues({}); }); }}>
                {spec.fields.map((fieldSpec) => fieldSpec.textarea
                  ? <Textarea key={fieldSpec.name} aria-label={`${spec.title} ${fieldSpec.label}`} placeholder={fieldSpec.label} value={values[fieldSpec.name] ?? ""} onChange={(event) => setValues({ ...values, [fieldSpec.name]: event.target.value })} className="min-h-24 rounded-none font-mono text-[11px] placeholder:text-[#63615a]" />
                  : <Input key={fieldSpec.name} aria-label={`${spec.title} ${fieldSpec.label}`} type={fieldSpec.secret ? "password" : "text"} autoComplete="off" placeholder={`${fieldSpec.label}${fieldSpec.optional ? " (optional)" : ""}${fieldSpec.placeholder ? ` · ${fieldSpec.placeholder}` : ""}`} value={values[fieldSpec.name] ?? ""} onChange={(event) => setValues({ ...values, [fieldSpec.name]: event.target.value })} className={field} />)}
                <Button type="submit" disabled={pending} className="h-8 w-full rounded-none bg-[#171713] text-[12px] text-white">Save encrypted</Button>
              </form> : null}

              <div className="mt-4 border-t border-[#d8d4ca] pt-3">
                <p className="mb-1 flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-[#5f5d56]"><CalendarClock className="h-3 w-3" aria-hidden="true" />Automatic collection</p>
                {TARGETED[item.kind] ? <Input aria-label={`${spec.title} target`} placeholder={TARGETED[item.kind]} value={targets[item.kind] ?? current?.target ?? ""} onChange={(event) => setTargets({ ...targets, [item.kind]: event.target.value })} className={cn(field, "mb-2")} /> : null}
                <div className="flex flex-wrap items-center gap-2">
                  <select aria-label={`${spec.title} schedule`} value={current?.enabled ? current.intervalMinutes : 0} disabled={busy} onChange={(event) => saveSchedule(item.kind, Number(event.target.value))} className={select}>{INTERVALS.map(([minutes, label]) => <option key={minutes} value={minutes}>{label}</option>)}</select>
                  {current ? <Button type="button" variant="outline" disabled={busy} onClick={() => post("/api/schedules", { action: "run_now", id: current.id }, "Collection finished")} className="h-8 rounded-none border-[#171713] bg-transparent text-[11px]">Run now</Button> : null}
                </div>
                {newTarget ? <p className="mt-2 text-[11px] text-[#55534b]">New target: choose an interval above to save it, then use Run now.</p> : null}
                {current ? <p className={cn("mt-2 font-mono text-[10px]", current.failing ? "font-bold text-[#b8322a]" : "text-[#5f5d56]")}>{current.failing ? `FAILING (${current.consecutiveFailures} in a row): ${current.lastError}` : `${current.lastStatus ?? "pending"} · last ${day(current.lastRunAt)} · next ${current.enabled ? current.nextRunAt.slice(0, 16).replace("T", " ") : "off"}`}</p> : null}
              </div>
            </div>);
        })}
      </div>
      {runs.length ? <div className="max-w-3xl"><MicroLabel>Recent collections</MicroLabel><div tabIndex={0} role="region" aria-label="Recent collections, scrollable" className="mt-2 overflow-x-auto border border-[#cbc7bd] focus-visible:outline-2 focus-visible:outline-[#171713]"><table className="w-full min-w-[520px] text-left text-[11px]"><caption className="sr-only">Recent collections</caption><tbody>{runs.slice(0, 8).map((run) => <tr key={run.id} className="border-t border-[#d8d4ca] first:border-t-0"><td className="px-3 py-2 font-mono">{run.started_at.slice(0, 16).replace("T", " ")}</td><td className="px-3 py-2">{run.kind}{run.target ? ` · ${run.target}` : ""}</td><td className="px-3 py-2 font-mono uppercase">{run.trigger}</td><td className={cn("px-3 py-2 font-mono uppercase", run.status === "failed" ? "text-[#b8322a]" : "text-[#245c3f]")}>{run.status}</td><td className="px-3 py-2 text-[#5f5d56]">{run.error ?? ""}</td></tr>)}</tbody></table></div></div> : null}
    </div>
  );
}

/** Accepts a pasted URL, a trailing .git or stray spaces and returns the bare "owner/repository" (or "group/project") path. */
function normalizeTarget(value: string) {
  return value.trim().replace(/^https?:\/\/[^/]+\//i, "").replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
}

function paramsFor(kind: string, rawTarget: string): Record<string, string> {
  const target = normalizeTarget(rawTarget);
  if (kind === "github") { const [owner, repository] = target.split("/"); return { owner: owner ?? "", repository: repository ?? "" }; }
  if (kind === "gitlab") return { project: target };
  return {};
}

function Authentication({ snapshot }: { snapshot: Snapshot }) {
  const { authentication: a } = snapshot;
  const rows: Array<[string, boolean, string]> = [
    ["Single sign-on (OIDC)", a.oidc, a.oidc ? "Configured. New sign-ins are matched by verified email to the users above." : "Not configured: set OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET."],
    ["Role claims from the identity provider", !a.oidcRoleClaimTrusted, a.oidcRoleClaimTrusted ? "Trusted: the identity provider assigns roles. Prefer assigning them here." : "Not trusted (recommended): roles are the ones assigned in this console."],
    ["Demo sessions", !a.demoSessions, a.demoSessions ? "Enabled: anyone reaching this instance acts as the demo administrator. Never expose it." : "Disabled."],
    ["Credential encryption key", a.secretsKeyConfigured, a.secretsKeyConfigured ? "KONTROL_SECRETS_KEY is set." : "Not set: a development key protects stored credentials."],
    ["Signed webhook ingest", a.ingestConfigured, a.ingestConfigured ? "KONTROL_INGEST_SECRET is set." : "Not set: HR and learning-system reports are refused."],
  ];
  return (
    <div className="max-w-3xl border border-[#cbc7bd]">
      {rows.map(([label, good, text]) => <div key={label} className="flex items-start gap-3 border-b border-[#d8d4ca] p-4 last:border-b-0"><ShieldCheck className={cn("mt-0.5 h-4 w-4 shrink-0", good ? "text-[#245c3f]" : "text-[#7a5a1a]")} aria-hidden="true" /><div><p className="text-[13px] font-semibold">{label}</p><p className="text-[11px] text-[#55534b]">{text}</p></div></div>)}
    </div>
  );
}

type Channel = { id: string; kind: string; name: string; events: string[]; minSeverity: string; enabled: boolean; hint: string; lastStatus: string | null; lastError: string | null; lastSentAt: string | null };
type OutboxItem = { id: string; channel_id: string; event_type: string; severity: string; title: string; status: string; attempts: number; last_error: string | null; created_at: string; sent_at: string | null };
const CHANNEL_KINDS: Record<string, { title: string; fields: FieldSpec[] }> = {
  slack: { title: "Slack (or compatible)", fields: [{ name: "webhookUrl", label: "Incoming webhook URL", secret: true }] },
  webhook: { title: "Signed webhook", fields: [{ name: "url", label: "Endpoint URL", secret: true }] },
  email: { title: "Email (SMTP)", fields: [{ name: "host", label: "SMTP host" }, { name: "port", label: "Port", placeholder: "587" }, { name: "user", label: "Username", optional: true }, { name: "pass", label: "Password", secret: true, optional: true }, { name: "from", label: "From address" }, { name: "to", label: "Recipients, comma separated" }] },
  jira: { title: "Jira", fields: [{ name: "baseUrl", label: "Site URL", placeholder: "https://your-site.atlassian.net" }, { name: "email", label: "Account email" }, { name: "apiToken", label: "API token", secret: true }, { name: "projectKey", label: "Project key", placeholder: "SEC" }, { name: "issueType", label: "Issue type", optional: true, placeholder: "Task" }] },
};
const SEVERITY_LEVELS = ["low", "medium", "high", "critical"];

function Notifications({ pending }: { pending: boolean }) {
  const [data, setData] = useState<{ channels: Channel[]; outbox: OutboxItem[]; events: string[] } | null>(null);
  const [message, setMessage] = useState("");
  const [kind, setKind] = useState("slack");
  const [values, setValues] = useState<Record<string, string>>({});
  const [flags, setFlags] = useState({ secure: false, includeAssignee: false });
  const [name, setName] = useState("");
  const [minSeverity, setMinSeverity] = useState("low");
  const [events, setEvents] = useState<string[]>([]);
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, startBusy] = useTransition();

  const load = useCallback(() => fetchJson<{ channels: Channel[]; outbox: OutboxItem[]; events: string[] }>("/api/notifications").then(setData).catch((error: unknown) => setMessage(errorMessage(error, "Notifications unavailable"))), []);
  useEffect(() => { void load(); }, [load]);

  const post = (body: Record<string, unknown>, success: string, after?: (result: Record<string, unknown>) => void) => startBusy(async () => {
    try { setMessage("Working…"); const result = await fetchJson<Record<string, unknown>>("/api/notifications", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); await load(); setMessage(typeof result.detail === "string" ? `${success}: ${result.detail}` : success); after?.(result); }
    catch (error) { setMessage(errorMessage(error, "Action failed")); }
  });

  function create() {
    const config: Record<string, unknown> = Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim() !== ""));
    if (kind === "email") { config.port = Number(values.port || 587); config.to = String(values.to ?? "").split(",").map((item) => item.trim()).filter(Boolean); config.secure = flags.secure; config.includeAssignee = flags.includeAssignee; }
    post({ action: "create_channel", kind, name, config, events: events.length ? events : ["*"], minSeverity }, "Channel created", (result) => { setValues({}); setName(""); setEvents([]); if (typeof result.signingSecret === "string") setSecret(result.signingSecret); });
  }

  const spec = CHANNEL_KINDS[kind];
  const nameOf = (id: string) => data?.channels.find((channel) => channel.id === id)?.name ?? "deleted channel";
  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-[12px] text-[#55534b]">Channels receive the events you choose: tasks assigned or overdue, new high-severity findings, risk acceptances awaiting a decision, attestations and policies falling due, failing connectors. Destinations are encrypted and never shown again; deliveries retry with back-off and never follow redirects or reach private networks.</p>
      {message ? <p role="status" className="text-[11px] font-medium text-[#34332e]">{message}</p> : null}
      {secret ? <div role="status" className="border border-[#245c3f] bg-[#dcebe1] p-4 text-[12px] text-[#173d2a]"><p className="font-semibold">Signing secret. Shown once: store it in the receiving system.</p><code className="mt-2 block break-all bg-white px-2 py-1 font-mono text-[12px]">{secret}</code><p className="mt-2 text-[11px]">Each request carries <code className="font-mono">X-Kontrol-Timestamp</code> and <code className="font-mono">X-Kontrol-Signature: sha256=HMAC(secret, timestamp.body)</code>.</p><Button type="button" variant="ghost" onClick={() => setSecret(null)} className="mt-1 h-7 rounded-none text-[11px]">I have stored it</Button></div> : null}
      <div className="grid gap-8 xl:grid-cols-[360px_1fr]">
        <form className="h-fit space-y-2 border border-[#cbc7bd] p-4" onSubmit={(event) => { event.preventDefault(); create(); }}>
          <MicroLabel>Add a channel</MicroLabel>
          <select aria-label="Channel type" value={kind} onChange={(event) => { setKind(event.target.value); setValues({}); }} className={cn(select, "w-full")}>{Object.entries(CHANNEL_KINDS).map(([key, item]) => <option key={key} value={key}>{item.title}</option>)}</select>
          <Input aria-label="Channel name" placeholder="Name (for example #security-alerts)" value={name} onChange={(event) => setName(event.target.value)} className={field} />
          {spec.fields.map((fieldSpec) => <Input key={fieldSpec.name} aria-label={`${spec.title} ${fieldSpec.label}`} type={fieldSpec.secret ? "password" : "text"} autoComplete="off" placeholder={`${fieldSpec.label}${fieldSpec.optional ? " (optional)" : ""}${fieldSpec.placeholder ? ` · ${fieldSpec.placeholder}` : ""}`} value={values[fieldSpec.name] ?? ""} onChange={(event) => setValues({ ...values, [fieldSpec.name]: event.target.value })} className={field} />)}
          {kind === "email" ? <div className="space-y-1 text-[11px]"><label className="flex items-center gap-2"><input type="checkbox" checked={flags.secure} onChange={(event) => setFlags({ ...flags, secure: event.target.checked })} />Use TLS from the start (port 465)</label><label className="flex items-center gap-2"><input type="checkbox" checked={flags.includeAssignee} onChange={(event) => setFlags({ ...flags, includeAssignee: event.target.checked })} />Also email the task assignee</label></div> : null}
          <select aria-label="Minimum severity" value={minSeverity} onChange={(event) => setMinSeverity(event.target.value)} className={cn(select, "w-full")}>{SEVERITY_LEVELS.map((level) => <option key={level} value={level}>{level === "low" ? "All severities" : `${level} and above`}</option>)}</select>
          <fieldset className="border border-[#d8d4ca] p-2"><legend className="px-1 font-mono text-[10px] uppercase text-[#5f5d56]">Events (none selected = all)</legend><div className="grid max-h-36 grid-cols-1 gap-0.5 overflow-y-auto text-[11px]">{(data?.events ?? []).filter((eventName) => eventName !== "test").map((eventName) => <label key={eventName} className="flex items-center gap-2"><input type="checkbox" checked={events.includes(eventName)} onChange={(event) => setEvents(event.target.checked ? [...events, eventName] : events.filter((item) => item !== eventName))} />{eventName}</label>)}</div></fieldset>
          <Button type="submit" disabled={busy || pending || name.trim().length < 2} className="h-8 w-full rounded-none bg-[#171713] text-[12px] text-white"><Bell className="me-1.5 h-3 w-3" aria-hidden="true" />Add channel</Button>
        </form>
        <div className="space-y-6">
          <div className="grid gap-3 md:grid-cols-2">{(data?.channels ?? []).map((channel) => (
            <div key={channel.id} className="border border-[#cbc7bd] bg-[#f8f6f0] p-4">
              <div className="flex items-start justify-between gap-2"><div><p className="text-[13px] font-semibold">{channel.name}</p><p className="font-mono text-[10px] text-[#5f5d56]">{channel.kind} · {channel.hint}</p></div><span className={cn("px-1.5 py-0.5 font-mono text-[10px] uppercase", channel.enabled ? "bg-[#dcebe1] text-[#245c3f]" : "bg-[#e5e2d8] text-[#5f5d56]")}>{channel.enabled ? "on" : "off"}</span></div>
              <p className="mt-1 text-[11px] text-[#55534b]">{channel.events.includes("*") ? "All events" : channel.events.join(", ")} · {channel.minSeverity === "low" ? "all severities" : `${channel.minSeverity}+`}</p>
              {channel.lastStatus ? <p className={cn("mt-1 font-mono text-[10px]", channel.lastStatus === "failing" ? "text-[#b8322a]" : "text-[#5f5d56]")}>{channel.lastStatus === "failing" ? `failing: ${channel.lastError}` : `last delivery ${channel.lastSentAt?.slice(0, 16).replace("T", " ")}`}</p> : null}
              <div className="mt-3 flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={busy} onClick={() => post({ action: "test_channel", id: channel.id }, "Test sent")} className="h-7 rounded-none border-[#171713] bg-transparent text-[11px]">Send test</Button>
                <Button type="button" variant="outline" disabled={busy} onClick={() => post({ action: "set_enabled", id: channel.id, enabled: !channel.enabled }, channel.enabled ? "Channel turned off" : "Channel turned on")} className="h-7 rounded-none border-[#171713] bg-transparent text-[11px]">{channel.enabled ? "Turn off" : "Turn on"}</Button>
                <Button type="button" variant="outline" disabled={busy} onClick={() => { if (window.confirm(`Delete ${channel.name} and its queued messages?`)) post({ action: "delete_channel", id: channel.id }, "Channel deleted"); }} className="h-7 rounded-none border-[#b8322a] bg-transparent text-[11px] text-[#b8322a]"><Trash2 className="me-1 h-3 w-3" aria-hidden="true" />Delete</Button></div>
            </div>))}
          </div>
          {data && data.channels.length === 0 ? <p className="text-[12px] text-[#5f5d56]">No channels yet. Add one to receive alerts.</p> : null}
          {data?.outbox.length ? <div><MicroLabel>Recent messages</MicroLabel><div tabIndex={0} role="region" aria-label="Recent messages, scrollable" className="mt-2 overflow-x-auto border border-[#cbc7bd] focus-visible:outline-2 focus-visible:outline-[#171713]"><table className="w-full min-w-[640px] text-left text-[11px]"><caption className="sr-only">Recent messages</caption><tbody>{data.outbox.slice(0, 12).map((item) => <tr key={item.id} className="border-t border-[#d8d4ca] first:border-t-0"><td className="px-3 py-2 font-mono">{item.created_at.slice(0, 16).replace("T", " ")}</td><td className="px-3 py-2">{item.title}<span className="block font-mono text-[10px] text-[#5f5d56]">{item.event_type} · {nameOf(item.channel_id)}</span></td><td className={cn("px-3 py-2 font-mono uppercase", item.status === "sent" ? "text-[#245c3f]" : item.status === "pending" ? "text-[#5f5d56]" : "text-[#b8322a]")}>{item.status}{item.attempts ? ` (${item.attempts})` : ""}</td><td className="px-3 py-2 text-end">{item.status === "dead" || item.status === "failed" ? <Button type="button" variant="outline" disabled={busy} onClick={() => post({ action: "retry", id: item.id }, "Message re-queued")} className="h-6 rounded-none border-[#171713] bg-transparent text-[10px]">Retry</Button> : null}</td></tr>)}</tbody></table></div></div> : null}
        </div>
      </div>
    </div>
  );
}
