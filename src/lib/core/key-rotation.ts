import "server-only";

import type { Actor } from "@/lib/core/auth";
import { resealCredentials } from "@/lib/core/credentials";
import { appendAudit } from "@/lib/core/integrity";
import { resealDocuments } from "@/lib/core/vault-store";

/**
 * Rotation of KONTROL_SECRETS_KEY, in three steps the operator controls:
 *   1. set KONTROL_SECRETS_KEY to the new key and put the old one in KONTROL_SECRETS_KEY_PREVIOUS, then restart;
 *   2. run this: everything sealed under the old key is re-sealed under the new one;
 *   3. once nothing is left, remove the old key from KONTROL_SECRETS_KEY_PREVIOUS.
 * Nothing is ever left unreadable in between, and a failed item is reported, not skipped silently.
 */
export async function rotateSecretKeys(actor: Actor) {
  const credentials = await resealCredentials(actor);
  const documents = await resealDocuments(actor);
  const remaining = credentials.failed.length + documents.failed.length;
  await appendAudit({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    action: "keys.rotated",
    objectType: "tenant",
    objectId: actor.tenantId,
    payload: {
      credentials: { resealed: credentials.resealed, failed: credentials.failed.length },
      documents: { resealed: documents.resealed, failed: documents.failed.length },
    },
  });
  return { credentials, documents, complete: remaining === 0 };
}
