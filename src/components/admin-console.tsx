"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { Copy, KeyRound, Plug, ShieldCheck, Trash2, UserPlus } from "lucide-react";
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

const tabs = ["Users", "API keys", "Connections", "Authentication"] as const;
type Tab = (typeof tabs)[number];
const ROLES: Role[] = ["admin", "risk_owner", "control_owner", "auditor", "viewer"];
const ROLE_HELP: Record<Role, string> = { admin: "Everything, including users and credentials", risk_owner: "Simulates risk, approves decisions and reviews", control_owner: "Evaluates controls, uploads evidence, syncs connectors", auditor: "Read-only access with exports", viewer: "Read-only" };
const field = "h-8 rounded-none border-[#cbc7bd] bg-transparent text-[10px] shadow-none placeholder:text-[#63615a]";
const select = "h-8 border border-[#cbc7bd] bg-transparent px-2 text-[10px] focus-visible:outline-2 focus-visible:outline-[#171713]";

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
        {failed ? <div role="alert" className="mb-4 border border-[#b8322a] bg-[#f5e5e1] p-3 text-[9px] text-[#9f2923]">{status}. Administration requires the administrator role.</div> : null}
        <div role="tablist" aria-label="Administration sections" className="mb-6 flex flex-wrap border-b border-[#cbc7bd]">
          {tabs.map((name) => <button key={name} role="tab" aria-selected={tab === name} type="button" onClick={() => setTab(name)} className={cn("px-4 py-2.5 text-[10px] font-medium", tab === name ? "border-b-2 border-[#171713] text-[#171713]" : "text-[#5f5d56] hover:text-[#171713]")}>{name}</button>)}
        </div>
        {snapshot && tab === "Users" ? <Users snapshot={snapshot} act={act} pending={isPending} /> : null}
        {snapshot && tab === "API keys" ? <Keys snapshot={snapshot} act={act} pending={isPending} newKey={newKey} setNewKey={setNewKey} /> : null}
        {snapshot && tab === "Connections" ? <Connections snapshot={snapshot} act={act} pending={isPending} /> : null}
        {snapshot && tab === "Authentication" ? <Authentication snapshot={snapshot} /> : null}
        {!snapshot && !failed ? <div className="grid min-h-40 place-items-center text-[9px] text-[#63615a]">Loading…</div> : null}
      </section>
    </div>
  );
}

type Act = (body: Record<string, unknown>, success: string, after?: (result: Record<string, unknown>) => void) => void;
const day = (value: string | null) => (value ? value.slice(0, 10) : "never");

function Users({ snapshot, act, pending }: { snapshot: Snapshot; act: Act; pending: boolean }) {
  const [form, setForm] = useState({ email: "", name: "", role: "viewer" as Role });
  return (
    <div className="grid gap-8 xl:grid-cols-[320px_1fr]">
      <form className="space-y-2 border border-[#cbc7bd] p-4" onSubmit={(event) => { event.preventDefault(); act({ action: "invite_user", ...form }, "User created", () => setForm({ email: "", name: "", role: "viewer" })); }}>
        <MicroLabel>Add a user</MicroLabel>
        <Input aria-label="Full name" placeholder="Full name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} className={field} />
        <Input aria-label="Email" type="email" placeholder="Email (matches their single sign-on identity)" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} className={field} />
        <select aria-label="Role" value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value as Role })} className={cn(select, "w-full")}>{ROLES.map((role) => <option key={role} value={role}>{role.replace("_", " ")}</option>)}</select>
        <p className="text-[8px] text-[#5f5d56]">{ROLE_HELP[form.role]}</p>
        <Button type="submit" disabled={pending || form.name.trim().length < 2 || !form.email.includes("@")} className="h-8 w-full rounded-none bg-[#171713] text-[10px] text-white"><UserPlus className="me-1.5 h-3 w-3" aria-hidden="true" />Add user</Button>
        <p className="text-[8px] text-[#5f5d56]">Sign-in is through your identity provider; the role set here applies when they first sign in.</p>
      </form>
      <div tabIndex={0} role="region" aria-label="Users table, scrollable" className="overflow-x-auto border border-[#cbc7bd] focus-visible:outline-2 focus-visible:outline-[#171713]"><table className="w-full min-w-[640px] text-left text-[9px]"><caption className="sr-only">Users</caption>
        <thead><tr className="bg-[#e9e5db] font-mono text-[7px] uppercase tracking-wider text-[#5f5d56]">{["User", "Role", "Status", "Last sign-in", ""].map((h) => <th key={h} scope="col" className="px-3 py-2.5">{h}</th>)}</tr></thead>
        <tbody>{snapshot.users.map((user) => (
          <tr key={user.id} className="border-t border-[#d8d4ca]">
            <td className="px-3 py-3"><span className="block font-medium">{user.name}</span><span className="font-mono text-[8px] text-[#5f5d56]">{user.email}</span></td>
            <td className="px-3 py-3"><select aria-label={`Role of ${user.email}`} value={user.role} disabled={pending} onChange={(event) => act({ action: "set_role", userId: user.id, role: event.target.value }, "Role updated")} className={select}>{ROLES.map((role) => <option key={role} value={role}>{role.replace("_", " ")}</option>)}</select></td>
            <td className="px-3 py-3 font-mono uppercase">{user.status}</td>
            <td className="px-3 py-3 font-mono">{day(user.last_login_at)}</td>
            <td className="px-3 py-3 text-end"><Button type="button" variant="outline" disabled={pending} onClick={() => act({ action: "set_status", userId: user.id, status: user.status === "active" ? "disabled" : "active" }, user.status === "active" ? "User disabled" : "User enabled")} className="h-7 rounded-none border-[#171713] bg-transparent text-[8px]">{user.status === "active" ? "Disable" : "Enable"}</Button></td>
          </tr>))}</tbody></table></div>
    </div>
  );
}

function Keys({ snapshot, act, pending, newKey, setNewKey }: { snapshot: Snapshot; act: Act; pending: boolean; newKey: string | null; setNewKey: (value: string | null) => void }) {
  const [form, setForm] = useState({ name: "", role: "viewer" as Role, expiresInDays: 90 });
  return (
    <div className="space-y-6">
      {newKey ? <div role="status" className="border border-[#245c3f] bg-[#dcebe1] p-4 text-[10px] text-[#173d2a]"><p className="font-semibold">Copy this key now. It is shown once and cannot be recovered.</p><div className="mt-2 flex flex-wrap items-center gap-2"><code className="break-all bg-white px-2 py-1 font-mono text-[10px]">{newKey}</code><Button type="button" variant="outline" onClick={() => void navigator.clipboard?.writeText(newKey)} className="h-7 rounded-none border-[#245c3f] bg-transparent text-[9px] text-[#245c3f]"><Copy className="me-1 h-3 w-3" aria-hidden="true" />Copy</Button><Button type="button" variant="ghost" onClick={() => setNewKey(null)} className="h-7 rounded-none text-[9px]">I have saved it</Button></div><p className="mt-2 text-[9px]">Use it as <code className="font-mono">Authorization: Bearer …</code>. It acts as you, with the role below, and stops working when it expires, is revoked, or you are disabled.</p></div> : null}
      <div className="grid gap-8 xl:grid-cols-[320px_1fr]">
        <form className="space-y-2 border border-[#cbc7bd] p-4" onSubmit={(event) => { event.preventDefault(); act({ action: "create_api_key", ...form }, "API key created", (result) => setNewKey(String(result.token ?? ""))); }}>
          <MicroLabel>Create an API key</MicroLabel>
          <Input aria-label="Key name" placeholder="Name (for example CI pipeline)" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} className={field} />
          <select aria-label="Key role" value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value as Role })} className={cn(select, "w-full")}>{ROLES.filter((role) => role !== "admin").map((role) => <option key={role} value={role}>{role.replace("_", " ")}</option>)}</select>
          <select aria-label="Key lifetime" value={form.expiresInDays} onChange={(event) => setForm({ ...form, expiresInDays: Number(event.target.value) })} className={cn(select, "w-full")}>{[7, 30, 90, 180, 365].map((days) => <option key={days} value={days}>Expires in {days} days</option>)}</select>
          <Button type="submit" disabled={pending || form.name.trim().length < 3} className="h-8 w-full rounded-none bg-[#171713] text-[10px] text-white"><KeyRound className="me-1.5 h-3 w-3" aria-hidden="true" />Create key</Button>
          <p className="text-[8px] text-[#5f5d56]">Keys can never be administrators.</p>
        </form>
        <div tabIndex={0} role="region" aria-label="API keys table, scrollable" className="overflow-x-auto border border-[#cbc7bd] focus-visible:outline-2 focus-visible:outline-[#171713]"><table className="w-full min-w-[640px] text-left text-[9px]"><caption className="sr-only">API keys</caption>
          <thead><tr className="bg-[#e9e5db] font-mono text-[7px] uppercase tracking-wider text-[#5f5d56]">{["Name", "Key", "Role", "Expires", "Last used", ""].map((h) => <th key={h} scope="col" className="px-3 py-2.5">{h}</th>)}</tr></thead>
          <tbody>{snapshot.apiKeys.map((key) => (
            <tr key={key.id} className="border-t border-[#d8d4ca]"><td className="px-3 py-3 font-medium">{key.name}</td><td className="px-3 py-3 font-mono">{key.prefix}…</td><td className="px-3 py-3">{key.role.replace("_", " ")}</td>
              <td className="px-3 py-3 font-mono">{key.revoked_at ? "revoked" : day(key.expires_at)}</td><td className="px-3 py-3 font-mono">{day(key.last_used_at)}</td>
              <td className="px-3 py-3 text-end">{key.active ? <Button type="button" variant="outline" disabled={pending} onClick={() => act({ action: "revoke_api_key", keyId: key.id }, "API key revoked")} className="h-7 rounded-none border-[#b8322a] bg-transparent text-[8px] text-[#b8322a]">Revoke</Button> : <span className="font-mono text-[8px] text-[#5f5d56]">inactive</span>}</td></tr>))}</tbody></table>
          {snapshot.apiKeys.length === 0 ? <p className="p-6 text-[10px] text-[#5f5d56]">No API keys yet.</p> : null}</div>
      </div>
    </div>
  );
}

function Connections({ snapshot, act, pending }: { snapshot: Snapshot; act: Act; pending: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const noKey = !snapshot.authentication.secretsKeyConfigured;
  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-[10px] text-[#55534b]"><Plug className="me-1 inline h-3 w-3" aria-hidden="true" />Credentials entered here are encrypted at rest (AES-256-GCM, bound to your tenant and the connector) and are never shown again: only the last four characters. They are used instead of environment variables.{noKey ? " KONTROL_SECRETS_KEY is not set: a development key is in use. Set a unique key before storing real credentials." : ""}</p>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {snapshot.credentials.map((item) => {
          const spec = CONNECTORS[item.kind];
          if (!spec) return null;
          return (
            <div key={item.kind} className="border border-[#cbc7bd] bg-[#f8f6f0] p-4">
              <div className="flex items-start justify-between gap-2"><p className="text-[12px] font-semibold">{spec.title}</p><span className={cn("px-1.5 py-0.5 font-mono text-[8px] uppercase", item.configured ? "bg-[#dcebe1] text-[#245c3f]" : "bg-[#e5e2d8] text-[#5f5d56]")}>{item.configured ? `configured …${item.hint}` : "not configured"}</span></div>
              <p className="mt-1 text-[9px] text-[#55534b]">{spec.help}</p>
              {item.configured ? <p className="mt-1 font-mono text-[8px] text-[#5f5d56]">Updated {day(item.rotatedAt)}</p> : null}
              <div className="mt-3 flex gap-2"><Button type="button" variant="outline" aria-expanded={open === item.kind} onClick={() => { setOpen(open === item.kind ? null : item.kind); setValues({}); }} className="h-7 rounded-none border-[#171713] bg-transparent text-[9px]">{item.configured ? "Replace" : "Configure"}</Button>
                {item.configured ? <Button type="button" variant="outline" disabled={pending} onClick={() => { if (window.confirm(`Remove the stored ${spec.title} credentials?`)) act({ action: "delete_credentials", kind: item.kind }, `${spec.title} credentials removed`); }} className="h-7 rounded-none border-[#b8322a] bg-transparent text-[9px] text-[#b8322a]"><Trash2 className="me-1 h-3 w-3" aria-hidden="true" />Remove</Button> : null}</div>
              {open === item.kind ? <form className="mt-3 space-y-2" onSubmit={(event) => { event.preventDefault(); const payload = Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim() !== "")); act({ action: "save_credentials", kind: item.kind, values: payload }, `${spec.title} credentials saved`, () => { setOpen(null); setValues({}); }); }}>
                {spec.fields.map((fieldSpec) => fieldSpec.textarea
                  ? <Textarea key={fieldSpec.name} aria-label={`${spec.title} ${fieldSpec.label}`} placeholder={fieldSpec.label} value={values[fieldSpec.name] ?? ""} onChange={(event) => setValues({ ...values, [fieldSpec.name]: event.target.value })} className="min-h-24 rounded-none font-mono text-[9px] placeholder:text-[#63615a]" />
                  : <Input key={fieldSpec.name} aria-label={`${spec.title} ${fieldSpec.label}`} type={fieldSpec.secret ? "password" : "text"} autoComplete="off" placeholder={`${fieldSpec.label}${fieldSpec.optional ? " (optional)" : ""}${fieldSpec.placeholder ? ` · ${fieldSpec.placeholder}` : ""}`} value={values[fieldSpec.name] ?? ""} onChange={(event) => setValues({ ...values, [fieldSpec.name]: event.target.value })} className={field} />)}
                <Button type="submit" disabled={pending} className="h-8 w-full rounded-none bg-[#171713] text-[10px] text-white">Save encrypted</Button>
              </form> : null}
            </div>);
        })}
      </div>
    </div>
  );
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
      {rows.map(([label, good, text]) => <div key={label} className="flex items-start gap-3 border-b border-[#d8d4ca] p-4 last:border-b-0"><ShieldCheck className={cn("mt-0.5 h-4 w-4 shrink-0", good ? "text-[#245c3f]" : "text-[#7a5a1a]")} aria-hidden="true" /><div><p className="text-[11px] font-semibold">{label}</p><p className="text-[9px] text-[#55534b]">{text}</p></div></div>)}
    </div>
  );
}
