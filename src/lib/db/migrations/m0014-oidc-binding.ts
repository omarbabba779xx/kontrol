import type { Migration } from "@/lib/db/migrations/runner";

/** The identity provider's issuer and subject an account is bound to at first sign-in, so a reassigned mailbox does not inherit it. */
export const oidcBinding: Migration = {
  id: 14,
  name: "oidc_binding",
  tables: [],
  up: () => [
    "ALTER TABLE users ADD COLUMN oidc_issuer TEXT",
    "ALTER TABLE users ADD COLUMN oidc_subject TEXT",
  ],
};
