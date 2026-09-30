import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { getDb } from "@/lib/core/database";
import { verifyAuditChain } from "@/lib/core/integrity";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const actor = await requireActor(request, "oscal:export");
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return Response.json({ error: "Request id required" }, { status: 400 });
    const db = getDb();
    const auditRequest = db.prepare("SELECT * FROM auditor_requests WHERE tenant_id=? AND id=?").get(actor.tenantId, id);
    if (!auditRequest) return Response.json({ error: "Auditor request not found" }, { status: 404 });
    const pack = { generatedAt: new Date().toISOString(), auditRequest, controls: db.prepare("SELECT id,code,title,status,frequency FROM controls WHERE tenant_id=? AND valid_to IS NULL").all(actor.tenantId), evidence: db.prepare("SELECT e.id,e.name,e.source,e.content_hash,e.collected_at,e.status,s.score,s.grade FROM evidence e LEFT JOIN evidence_scores s ON s.evidence_id=e.id WHERE e.tenant_id=?").all(actor.tenantId), decisions: db.prepare("SELECT id,subject_type,subject_id,outcome,rationale,decided_at,signature FROM decisions WHERE tenant_id=?").all(actor.tenantId), integrity: verifyAuditChain(actor.tenantId) };
    return Response.json(pack, { headers: { "Content-Disposition": `attachment; filename="assurance-pack-${id}.json"` } });
  } catch (error) { return apiError(error); }
}
