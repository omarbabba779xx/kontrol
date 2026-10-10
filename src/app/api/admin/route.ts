import { z } from "zod";
import { requireActor, type Permission } from "@/lib/core/auth";
import { rotateSecretKeys } from "@/lib/core/key-rotation";
import { apiError } from "@/lib/core/api";
import {
  adminSnapshot,
  createApiKey,
  inviteUser,
  renameOrganisation,
  renameUser,
  KEY_ROLES,
  revokeApiKey,
  revokeSessions,
  ROLES,
  setUserRole,
  setUserStatus,
} from "@/lib/core/admin";
import { CREDENTIAL_KINDS, deleteCredentials, saveCredentials, type CredentialKind } from "@/lib/core/credentials";

const role = z.enum(ROLES as [string, ...string[]]);
const kind = z.enum(CREDENTIAL_KINDS as [string, ...string[]]);

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("invite_user"),
    email: z.string().email(),
    name: z.string().min(2).max(120),
    role,
    external: z.boolean().default(false),
  }),
  z.object({ action: z.literal("rename_organisation"), name: z.string().min(2).max(120), region: z.string().min(2).max(40).optional() }),
  z.object({ action: z.literal("rename_user"), userId: z.string().min(3), name: z.string().min(2).max(120) }),
  z.object({ action: z.literal("set_role"), userId: z.string().min(3), role }),
  z.object({ action: z.literal("set_status"), userId: z.string().min(3), status: z.enum(["active", "disabled"]) }),
  z.object({
    action: z.literal("create_api_key"),
    name: z.string().min(3).max(80),
    role: z.enum(KEY_ROLES as [string, ...string[]]),
    expiresInDays: z.number().int().min(1).max(365).default(90),
  }),
  z.object({ action: z.literal("revoke_api_key"), keyId: z.string().min(3) }),
  z.object({ action: z.literal("save_credentials"), kind, values: z.record(z.string(), z.unknown()) }),
  z.object({ action: z.literal("rotate_keys") }),
  z.object({ action: z.literal("revoke_sessions"), userId: z.string().min(3) }),
  z.object({ action: z.literal("delete_credentials"), kind }),
]);

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const actor = await requireActor(request, "users:manage");
    return Response.json(await adminSnapshot(actor.tenantId));
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const input = actionSchema.parse(await request.json());
    const permission: Permission =
      input.action === "save_credentials" || input.action === "delete_credentials" || input.action === "rotate_keys"
        ? "credentials:manage"
        : "users:manage";
    const actor = await requireActor(request, permission);
    switch (input.action) {
      case "invite_user":
        return Response.json(await inviteUser(actor, { ...input, role: input.role as never }), { status: 201 });
      case "rename_organisation":
        return Response.json(await renameOrganisation(actor, input));
      case "rename_user":
        return Response.json(await renameUser(actor, input));
      case "set_role":
        return Response.json(await setUserRole(actor, { userId: input.userId, role: input.role as never }));
      case "set_status":
        return Response.json(await setUserStatus(actor, input));
      case "create_api_key":
        return Response.json(
          await createApiKey(actor, { name: input.name, role: input.role as never, expiresInDays: input.expiresInDays }),
          { status: 201 },
        );
      case "revoke_api_key":
        return Response.json(await revokeApiKey(actor, input.keyId));
      case "save_credentials":
        return Response.json(await saveCredentials(actor, input.kind as CredentialKind, input.values), { status: 201 });
      case "revoke_sessions":
        return Response.json(await revokeSessions(actor, { userId: input.userId }));
      case "rotate_keys":
        return Response.json(await rotateSecretKeys(actor));
      case "delete_credentials":
        return Response.json(await deleteCredentials(actor, input.kind as CredentialKind));
    }
  } catch (error) {
    return apiError(error);
  }
}
