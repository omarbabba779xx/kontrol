import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Actor } from "@/lib/core/auth";
import { userError } from "@/lib/core/errors";
import { appendAudit, canonicalJson, sha256 } from "@/lib/core/integrity";
import { getDb } from "@/lib/db";
import { FRAMEWORK_BY_ID } from "@/lib/frameworks/catalog";
import { controlsForParent } from "@/lib/frameworks/mapping";
import type { CustomRequirement } from "@/lib/frameworks/scoring";
import type { FrameworkId } from "@/lib/frameworks/types";

/**
 * Standards bodies license the full text of some frameworks (PCI DSS testing procedures, SOC 2 points of focus). Kontrol
 * ships only identifiers and short titles. An organisation that holds a licence can import its own copy: it is stored for
 * that tenant only, with the licence acknowledgement and a content hash, never in the repository, and it can be removed at any time.
 *
 * An imported item either adds text to an existing requirement, or defines a new sub-requirement under a parent; a
 * sub-requirement inherits its parent's control mapping and replaces the parent in the score.
 */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_ITEMS = 5000;

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._()\-]{0,39}$/, "Identifiers use letters, digits and . _ ( ) -");
const itemSchema = z.object({
  id,
  title: z.string().min(2).max(300).optional(),
  parent: id.optional(),
  procedure: z.string().min(1).max(20_000).optional(),
  guidance: z.string().min(1).max(20_000).optional(),
});

export const importSchema = z.object({
  framework: z.enum(["iso27001", "nist_csf", "soc2", "gdpr", "nis2", "dora", "eu_ai_act", "iso42001", "pci_dss", "cis_v8", "cobit2019", "ma_0520", "ma_0908"]),
  sourceLabel: z.string().min(3).max(200),
  licenceReference: z.string().min(3).max(200),
  /** The importer confirms their organisation is licensed to hold and use this content internally. */
  acknowledgeLicence: z.literal(true, { message: "You must confirm that your organisation is licensed to use this content" }),
  items: z.array(itemSchema).min(1).max(MAX_ITEMS),
});
export type LicensedImport = z.infer<typeof importSchema>;

type CustomRow = { requirement_id: string; title: string; parent: string; framework_id: FrameworkId };

/** Sub-requirements an organisation imported, with the controls they inherit from their parents. */
export async function loadCustomRequirements(tenantId: string) {
  const rows = await (
    await getDb()
  )
    .scope(tenantId)
    .all<CustomRow>(
      "SELECT framework_id, requirement_id, title, parent FROM custom_requirements WHERE tenant_id = ? ORDER BY framework_id, requirement_id",
      tenantId,
    );
  const out = new Map<FrameworkId, CustomRequirement[]>();
  const byKey = new Map(rows.map((row) => [`${row.framework_id}|${row.requirement_id}`, row]));
  for (const row of rows) {
    const framework = FRAMEWORK_BY_ID.get(row.framework_id);
    if (!framework) continue;
    // Walk up through imported parents to the catalogue item or group this branch hangs from.
    let root = row.parent;
    for (let depth = 0; depth < 9; depth++) {
      const next = byKey.get(`${row.framework_id}|${root}`);
      if (!next) break;
      root = next.parent;
    }
    const parent = framework.requirements.find((item) => item.id === root);
    const group = parent?.group ?? framework.groups?.find((item) => item.id === root)?.title ?? root;
    const list = out.get(row.framework_id) ?? [];
    list.push({ id: row.requirement_id, title: row.title, group, parent: row.parent, controls: controlsForParent(row.framework_id, root) });
    out.set(row.framework_id, list);
  }
  return out;
}

export async function loadLicensedText(tenantId: string, frameworkId: FrameworkId) {
  const db = (await getDb()).scope(tenantId);
  const rows = await db.all<{ requirement_id: string; kind: "procedure" | "guidance"; body: string; source_label: string }>(
    "SELECT c.requirement_id, c.kind, c.body, i.source_label FROM licensed_content c JOIN content_imports i ON i.id = c.import_id WHERE c.tenant_id = ? AND c.framework_id = ? AND i.status = 'active'",
    tenantId,
    frameworkId,
  );
  const out = new Map<string, Array<{ kind: "procedure" | "guidance"; body: string; sourceLabel: string }>>();
  for (const row of rows)
    out.set(row.requirement_id, [
      ...(out.get(row.requirement_id) ?? []),
      { kind: row.kind, body: row.body, sourceLabel: row.source_label },
    ]);
  return out;
}

export async function listImports(tenantId: string) {
  return (await getDb())
    .scope(tenantId)
    .all<{
      id: string;
      framework_id: string;
      source_label: string;
      licence_reference: string;
      acknowledged_by: string;
      acknowledged_at: string;
      items: number;
      content_hash: string;
      status: string;
    }>(
      "SELECT id, framework_id, source_label, licence_reference, acknowledged_by, acknowledged_at, items, content_hash, status FROM content_imports WHERE tenant_id = ? AND status = 'active' ORDER BY acknowledged_at DESC",
      tenantId,
    );
}

/** Validates the whole import before writing anything, then replaces the framework's previous import atomically. */
export async function importLicensedContent(actor: Actor, raw: unknown) {
  const input = importSchema.parse(raw);
  const framework = FRAMEWORK_BY_ID.get(input.framework)!;
  const known = new Set(framework.requirements.map((item) => item.id));
  const parents = new Set([...known, ...(framework.groups ?? []).map((item) => item.id)]);

  const importIds = new Set(input.items.map((item) => item.id));
  const seen = new Set<string>();
  const customs: Array<{ id: string; title: string; parent: string }> = [];
  const texts: Array<{ id: string; kind: "procedure" | "guidance"; body: string }> = [];
  for (const [index, item] of input.items.entries()) {
    const where = `Item ${index + 1} (${item.id})`;
    if (seen.has(item.id)) throw userError(`${where}: duplicate identifier`);
    seen.add(item.id);
    if (!item.procedure && !item.guidance && known.has(item.id))
      throw userError(`${where}: nothing to import for an existing requirement (provide procedure or guidance)`);
    if (!known.has(item.id)) {
      if (!item.title) throw userError(`${where}: a new sub-requirement needs a title`);
      if (!item.parent || !(parents.has(item.parent) || importIds.has(item.parent)))
        throw userError(`${where}: a new sub-requirement needs a parent that exists in ${framework.name}`);
      customs.push({ id: item.id, title: item.title, parent: item.parent });
    }
    if (item.procedure) texts.push({ id: item.id, kind: "procedure", body: item.procedure });
    if (item.guidance) texts.push({ id: item.id, kind: "guidance", body: item.guidance });
  }
  // A new sub-requirement may sit under another imported one, but every chain must end in the catalogue.
  const importedParents = new Map(customs.map((item) => [item.id, item.parent]));
  for (const item of customs) {
    let cursor: string | undefined = item.parent;
    for (let depth = 0; cursor && importedParents.has(cursor); depth++) {
      if (depth > 8 || cursor === item.id) throw userError(`Item ${item.id}: circular or too deep parent chain`);
      cursor = importedParents.get(cursor);
    }
    if (!cursor || !parents.has(cursor)) throw userError(`Item ${item.id}: parent chain does not reach ${framework.name}`);
  }

  const contentHash = sha256(canonicalJson({ framework: input.framework, items: input.items }));
  const importId = `imp_${randomUUID()}`;
  const at = new Date().toISOString();
  const db = (await getDb()).scope(actor.tenantId);
  await db.transaction(async (tx) => {
    await tx.run(
      "UPDATE content_imports SET status = 'removed', removed_at = ? WHERE tenant_id = ? AND framework_id = ? AND status = 'active'",
      at,
      actor.tenantId,
      input.framework,
    );
    await tx.run("DELETE FROM custom_requirements WHERE tenant_id = ? AND framework_id = ?", actor.tenantId, input.framework);
    await tx.run("DELETE FROM licensed_content WHERE tenant_id = ? AND framework_id = ?", actor.tenantId, input.framework);
    await tx.run(
      "INSERT INTO content_imports (id,tenant_id,framework_id,source_label,licence_reference,acknowledged_by,acknowledged_at,items,content_hash,status) VALUES (?,?,?,?,?,?,?,?,?,?)",
      importId,
      actor.tenantId,
      input.framework,
      input.sourceLabel,
      input.licenceReference,
      actor.userId,
      at,
      input.items.length,
      contentHash,
      "active",
    );
    for (const item of customs)
      await tx.run(
        "INSERT INTO custom_requirements (id,tenant_id,framework_id,requirement_id,title,parent,import_id,created_at) VALUES (?,?,?,?,?,?,?,?)",
        `creq_${randomUUID()}`,
        actor.tenantId,
        input.framework,
        item.id,
        item.title,
        item.parent,
        importId,
        at,
      );
    for (const text of texts)
      await tx.run(
        "INSERT INTO licensed_content (id,tenant_id,framework_id,requirement_id,kind,body,import_id) VALUES (?,?,?,?,?,?,?)",
        `lc_${randomUUID()}`,
        actor.tenantId,
        input.framework,
        text.id,
        text.kind,
        text.body,
        importId,
      );
    await appendAudit(
      {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "compliance.licensed_content_imported",
        objectType: "framework",
        objectId: input.framework,
        payload: {
          importId,
          sourceLabel: input.sourceLabel,
          licenceReference: input.licenceReference,
          items: input.items.length,
          subRequirements: customs.length,
          texts: texts.length,
          contentHash,
        },
      },
      tx,
    );
  });
  return { importId, framework: input.framework, subRequirements: customs.length, texts: texts.length, contentHash };
}

/** Removes everything imported for a framework, for example when a licence lapses. Scores revert to the catalogue. */
export async function removeLicensedContent(actor: Actor, frameworkId: FrameworkId) {
  if (!FRAMEWORK_BY_ID.has(frameworkId)) throw userError(`Framework ${frameworkId} not found`);
  const db = (await getDb()).scope(actor.tenantId);
  const counts = { subRequirements: 0, texts: 0 };
  await db.transaction(async (tx) => {
    counts.subRequirements = (
      await tx.run("DELETE FROM custom_requirements WHERE tenant_id = ? AND framework_id = ?", actor.tenantId, frameworkId)
    ).changes;
    counts.texts = (
      await tx.run("DELETE FROM licensed_content WHERE tenant_id = ? AND framework_id = ?", actor.tenantId, frameworkId)
    ).changes;
    await tx.run(
      "UPDATE content_imports SET status = 'removed', removed_at = ? WHERE tenant_id = ? AND framework_id = ? AND status = 'active'",
      new Date().toISOString(),
      actor.tenantId,
      frameworkId,
    );
    await appendAudit(
      {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "compliance.licensed_content_removed",
        objectType: "framework",
        objectId: frameworkId,
        payload: counts,
      },
      tx,
    );
  });
  return counts;
}
