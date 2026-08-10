# Contributing to Lexa

Thanks for considering a contribution. This repo is a public mirror of a
self-hosted project management tool — issues, PRs, and questions are welcome.

## Getting started

Requirements: [Bun](https://bun.sh) ≥ 1.x.

```bash
git clone https://github.com/yohanesgre/lexa.git
cd lexa
bun install
bun run setup          # first-time: admin email, API key, migrations, sample data
bun run dev:full       # API (:3000) + vite frontend (:5173)
# open http://localhost:5173
```

Before any frontend work, initialize the wireframes submodule:

```bash
git submodule update --init wireframes
```

> **Note:** `wireframes/` is a git submodule pointing at a **private** repo
> (`yohanesgre/lexa-wireframes`). External contributors cannot initialize it —
> frontend changes that must be designed in the wireframes first (new states,
> layout, copy, motion) require access to that repo. Backend, API, docs, and
> CLI contributions don't need it. If you want to work on the frontend, open
> an issue and ask for access.

## What to work on

- **Bugs and backend fixes** — no wireframe dependency, fully open.
- **API/MCP/docs** — the contracts in `docs/` are authoritative; docs changes
  must stay consistent with them.
- **Frontend UI** — possible only with wireframes access (see above); the
  app transcribes the wireframes exactly, so a wireframe change must land
  first.

Before starting something non-trivial, open an issue to confirm the direction —
the project was fully designed before implementation, and scope is kept tight
by design.

## Development workflow

1. **Docs are the authority.** Read the relevant sections before touching
   code, in this order: `docs/SCHEMA.md` → `docs/LAYERS.md` → `docs/API.md` →
   `docs/MCP.md` → `docs/ARCHITECTURE.md`. Names, error codes, route paths,
   and tool shapes must match them verbatim. If a doc conflicts with another,
   stop and ask — don't resolve it yourself.
2. **No scope creep.** If a feature, table, column, endpoint, or tool is not
   in the design docs, it doesn't get built. If something is missing, report
   it — don't add it.
3. **Wireframe-first (frontend only).** Any UI change is designed in
   `wireframes/src/` first (`bash wireframes/build.sh` rebuilds the previews),
   then transcribed into React components — no creative interpretation, no
   extra padding/borders/treatments beyond the wireframe. New wireframe CSS
   classes must be ported into `app/styles/phosphor.css`.
4. **Code conventions.** Effect-TS on the backend (`Effect.Service` +
   `Data.TaggedError`); thin repos (raw SQL, no business logic) and thinner
   routes (parse → call service → return); declarative error→status mapping.
   TypeScript strict, no `any` outside JSON-payload boundaries. No comments
   unless the behavior is genuinely non-obvious.
5. **Verify before pushing.** `tsc --noEmit` must pass, `vitest run` must be
   green. Run both before opening a PR.

## Pull requests

Trunk-based development: `main` is the single long-lived branch, always in a
shippable state. No long-lived feature branches.

- Keep changes small and merge fast — aim for PRs that can be reviewed and
  merged within a day. Large features land as a series of small merges, not
  one big branch.
- Conventional commit style: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`,
  `chore:` with a scope when useful (e.g. `fix(auth): ...`).
- Include the acceptance evidence: `tsc --noEmit` + `vitest run` output,
  plus a short "what/why" in the body (the diff shows the what; the why is
  the valuable part).
- Keep the diff focused — no unrelated reformatting or restyling.
- The repo is a single maintainer project; expect a review pass with
  concrete feedback rather than a fast merge.

## Reporting bugs

Include: what you did, what you expected, what happened, and the server log
line / API response if you have it. The error catalog in `docs/API.md`
(`ERROR_CODE` + HTTP status) helps pinpoint issues fast.

## License

By contributing you agree that your work will be licensed under the
[MIT License](LICENSE).
