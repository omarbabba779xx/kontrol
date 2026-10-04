# Contributing

## Before you push

```bash
npm run verify -- --e2e
```

It runs what CI runs: the lockfile check, lint, types, the Rego policies, the tests on SQLite and on PostgreSQL with row-level
security, the production build and the browser tests. A change is not ready while any of them fails.

## Changes that need a second person

This is a product about controls, so its own changes follow one. Open a pull request and have someone else review it when a change:

- touches authentication, authorisation, tenant isolation, signing, the audit chain or outbound requests (`src/lib/core/auth.ts`,
  `oidc.ts`, `signing.ts`, `integrity.ts`, `net-guard.ts`, `src/lib/db/`);
- changes how a score, a readiness level, a capability level or a risk rating is computed;
- adds or changes a mapping between a framework requirement and a control;
- adds a migration.

Protect `main` so that this is enforced rather than remembered: require a pull request with one approval and the CI checks, and do
not allow force pushes. On a repository with a single maintainer, at least require the CI checks to pass before merging.

## Rules the code follows

- **A fact that cannot be read is unknown, never a failure.** A collector returns `null` for what it could not see, and the control is
  skipped.
- **A judgement says where it comes from.** Evidence carries its provenance; a mapping link carries its basis; a design choice that no
  audit has confirmed is listed in [docs/VALIDATION.md](docs/VALIDATION.md).
- **Management decisions belong to an administrator, and a check that needs a second person refuses the first.**
- **Migrations are append-only.** Add the next number in `src/lib/db/migrations/`; never edit one that has shipped.
- **Every write that matters goes to the audit chain**, in the same transaction as the write.
- **Tests state behaviour.** A test name is a sentence about what the product does.

## Adding a framework or a control

A framework is a catalogue of requirements (`src/lib/frameworks/data/`) and a mapping to unified controls. Carry identifiers and short
titles only when the text is licensed, and say so in `granularity`. An executable control is a policy over facts in
`src/lib/connectors/pack.ts`; list the facts it needs in `requires` so that an unreadable fact skips it.
