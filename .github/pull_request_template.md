<!-- Wireframe-first: any UI change must be reflected in wireframes/ (submodule) and
     rebuilt with `bash wireframes/build.sh` BEFORE implementation. -->

## Summary

<!-- What changed and why. One paragraph. -->

fixes #

## Type of change

- [ ] Bug fix
- [ ] Feature
- [ ] Docs / tooling
- [ ] Breaking change — describe migration impact and upgrade steps for self-hosters:

## Screenshots and Media (if UI changed)

<!-- Before/after. Skip section if backend-only. -->

## How to test

<!-- Steps on `bun run dev:full` (API on :3000, UI on :5173): what to do, what to expect.
     Include curl/health-check for API-only changes. -->

## Checklist

- [ ] `tsc --noEmit` passes
- [ ] `vitest run` passes
- [ ] Migration SQL added + tested against an existing `data/lexa.db` (if schema changed)
- [ ] Docs updated if schema/API/MCP/GitHub-sync contract changed (SCHEMA.md, API.md, MCP.md, docs/GITHUB_SETUP.md)
- [ ] Wireframes updated and rebuilt if UI changed
- [ ] Tests added for service/API changes (if applicable)
- [ ] No unrelated changes
- [ ] AI assistance disclosed (if used)
