<!-- Design system first: `DESIGN.md` (normative tokens) + `.impeccable/design.json` are the authority
     for visual decisions, and any UI change carries a change spec (regions, states, copy, components)
     before implementation. Run `impeccable context` and the request's playbook before editing. -->

## Summary

<!-- What changed and why. One paragraph. -->

fixes #

## Type of change

- [ ] Bug fix
- [ ] Feature
- [ ] Docs / tooling
- [ ] Breaking change — describe migration impact and upgrade steps for self-hosters:

## Screenshots and Media (if UI changed)

<!-- Before/after at desktop (1440) and mobile (390), captured with agent-browser.
     Skip section if backend-only. -->

## How to test

<!-- Steps on `bun run dev` (API on :3000, UI on :5173): what to do, what to expect.
     Include curl/health-check for API-only changes. -->

## Checklist

- [ ] `tsc --noEmit` passes
- [ ] `vitest run` passes
- [ ] Migration SQL added + tested against an existing `data/lexa.db` (if schema changed)
- [ ] Docs updated if schema/API/GitHub-sync contract changed (SCHEMA.md, API.md, docs/GITHUB_SETUP.md)
- [ ] `DESIGN.md` honoured (tokens, and the `impeccable` flow: `context` -> playbook -> `craft-floor` -> `detect`)
- [ ] Change spec in the plan or PR: regions, states matrix (empty/loading/error/partial/denied), real copy, components/tokens used
- [ ] antislop Delivery Gate run, PASS/FAIL evidence in `status/<plan>/report.md`
- [ ] Tests added for service/API changes (if applicable)
- [ ] No unrelated changes
- [ ] AI assistance disclosed (if used)
