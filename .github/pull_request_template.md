## What changes

## Why

## How it was verified

- [ ] `npm run verify -- --e2e` passes
- [ ] New behaviour has a test whose name states it
- [ ] If a score, a readiness level, a capability level or a risk rating changes: the rule is written down and `docs/VALIDATION.md` is still true
- [ ] If a mapping changes: its basis is stated
- [ ] If the schema changes: a new migration, none edited

## Needs a second person

Authentication, authorisation, tenant isolation, signing, the audit chain, outbound requests, scoring rules, mappings and migrations
are reviewed by someone other than their author (see CONTRIBUTING.md).
