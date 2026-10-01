import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { getDb } from "@/lib/db";
import { verifyAuditChain } from "@/lib/core/integrity";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const actor = await requireActor(request, "graph:read");
    const db = (await getDb()).scope(actor.tenantId);
    const t = actor.tenantId;
    const counts = await db.get(`SELECT
      (SELECT COUNT(*) FROM assets WHERE tenant_id = ?) AS "assets",
      (SELECT COUNT(*) FROM controls WHERE tenant_id = ? AND valid_to IS NULL) AS "controls",
      (SELECT COUNT(*) FROM evidence WHERE tenant_id = ?) AS "evidence",
      (SELECT COUNT(*) FROM findings WHERE tenant_id = ? AND status = 'open') AS "openFindings",
      (SELECT COUNT(*) FROM decisions WHERE tenant_id = ?) AS "decisions",
      (SELECT COUNT(*) FROM obligations WHERE tenant_id = ? AND effective_to IS NULL) AS "obligations"`, t, t, t, t, t, t);
    const audit = await verifyAuditChain(t);
    const connectors = await db.all("SELECT id,kind,name,status,last_sync_at FROM connectors WHERE tenant_id = ? ORDER BY kind", t);
    const workflows = await db.all("SELECT id,kind,state,current_step,attempts,created_at,updated_at FROM workflows WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 8", t);
    const findings = await db.all("SELECT f.id,f.title,f.severity,f.status,f.opened_at,c.code AS control_code FROM findings f LEFT JOIN controls c ON c.id=f.control_id WHERE f.tenant_id = ? ORDER BY f.opened_at DESC LIMIT 8", t);
    const activity = await db.all("SELECT sequence,action,object_type,object_id,entry_hash,created_at FROM audit_log WHERE tenant_id = ? ORDER BY sequence DESC LIMIT 10", t);
    return Response.json({ actor, counts, audit, connectors, workflows, findings, activity });
  } catch (error) { return apiError(error); }
}
