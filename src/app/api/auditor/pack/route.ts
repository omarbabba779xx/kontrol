import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { getDb } from "@/lib/db";
import { verifyAuditChain } from "@/lib/core/integrity";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const actor = await requireActor(request, "oscal:export");
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return Response.json({ error: "Request id required" }, { status: 400 });
    const db = (await getDb()).scope(actor.tenantId);
    const auditRequest = await db.get("SELECT * FROM auditor_requests WHERE tenant_id=? AND id=?", actor.tenantId, id);
    if (!auditRequest) return Response.json({ error: "Auditor request not found" }, { status: 404 });
    const controls = await db.all(
      "SELECT id,code,title,status,frequency FROM controls WHERE tenant_id=? AND valid_to IS NULL",
      actor.tenantId,
    );
    const evidence = await db.all(
      "SELECT e.id,e.name,e.source,e.content_hash,e.collected_at,e.status,s.score,s.grade FROM evidence e LEFT JOIN evidence_scores s ON s.evidence_id=e.id WHERE e.tenant_id=?",
      actor.tenantId,
    );
    const decisions = await db.all(
      "SELECT id,subject_type,subject_id,outcome,rationale,decided_at,signature FROM decisions WHERE tenant_id=?",
      actor.tenantId,
    );
    const pack = {
      generatedAt: new Date().toISOString(),
      auditRequest,
      controls,
      evidence,
      decisions,
      integrity: await verifyAuditChain(actor.tenantId),
    };
    return Response.json(pack, { headers: { "Content-Disposition": `attachment; filename="assurance-pack-${id}.json"` } });
  } catch (error) {
    return apiError(error);
  }
}
