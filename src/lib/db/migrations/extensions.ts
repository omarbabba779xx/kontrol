import { identity } from "@/lib/db/migrations/m0002-identity";
import { scheduling } from "@/lib/db/migrations/m0003-scheduling";
import { tasksNotifications } from "@/lib/db/migrations/m0004-tasks-notifications";
import { auditWorkspace } from "@/lib/db/migrations/m0005-audit-workspace";
import { thirdParty } from "@/lib/db/migrations/m0006-third-party";
import { riskRegister } from "@/lib/db/migrations/m0007-risk-register";
import { aiGovernance } from "@/lib/db/migrations/m0008-ai-governance";
import { sessionRevocation } from "@/lib/db/migrations/m0009-session-revocation";
import { workflowExecution } from "@/lib/db/migrations/m0010-workflow-execution";
import { evidenceGaps } from "@/lib/db/migrations/m0011-evidence-gaps";
import { scoreHistory } from "@/lib/db/migrations/m0012-score-history";
import { auditAnchors } from "@/lib/db/migrations/m0013-audit-anchors";
import { oidcBinding } from "@/lib/db/migrations/m0014-oidc-binding";
import { rateLimits } from "@/lib/db/migrations/m0015-rate-limits";
import type { Migration } from "@/lib/db/migrations/runner";

/**
 * Migrations after the baseline, in order. Add new ones at the end with the next id; never edit or reorder one that has shipped.
 */
export const extensions: Migration[] = [identity, scheduling, tasksNotifications, auditWorkspace, thirdParty, riskRegister, aiGovernance, sessionRevocation, workflowExecution, evidenceGaps, scoreHistory, auditAnchors, oidcBinding, rateLimits];
