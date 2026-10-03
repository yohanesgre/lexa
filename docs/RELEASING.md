# Releasing Lexa

The web app and CLI have **independent versions** and **independent release
pipelines**. A version bump without its changelog entry is an incomplete
release.

## Deploy targets — policy

**Cloudflare Workers is the only deploy target.** New features land on the
Workers flavor; the Bun standalone flavor is frozen at its current features and
receives no new work (existing installs keep running). Releases ship the Workers
bundle — see *Web app release flow* below. The AI Assistant is Workers-only.

## Versioning — CalVer `YYYY.MINOR.MICRO`

Lexa uses Calendar Versioning ([CalVer](https://calver.org/)), scheme
`YYYY.MINOR.MICRO` — the same scheme as Unity and JetBrains IDEs
(`2025.1`, `2025.2`, …). The year is a timestamp, not a compatibility
promise: read "which release train am I on", not "will this break me"
(the changelog answers the latter).

- `YYYY` — calendar year (Gregorian, UTC) of the release, e.g. `2026`.
- `MINOR` — Nth feature release within that year, starting at `1`.
  Resets to `1` every January. May contain breaking changes; each ships
  with migration notes in the changelog entry.
- `MICRO` — patch/hotfix counter within `YYYY.MINOR`, starting at `0`.
  Backwards-compatible fixes only. Resets to `0` on every MINOR bump.
- No pre-release suffixes (`-rc1`, `-beta`, …) in tags or manifests;
  stabilization happens on the release branch before tagging.

Examples: `2026.1.0` (first feature release of 2026), `2026.1.1`
(hotfix on top), `2026.2.0` (second feature release), `2027.1.0`
(first release of the new year — MINOR resets even if 2026 ended at
`2026.5.x`).

History: `0.1.0`–`0.3.0` predate CalVer and were never tagged; their
changelog sections stay as-is for archaeology. `2026.1.0` is the first
tagged release of both artifacts.

Web app and CLI keep independent versions and pipelines (table above)
but follow the same scheme. They ship together at `2026.1.0` (the
Forge→Hearth rename breaks both sides at once) and may diverge after
that — e.g. web at `2026.2.0` while CLI stays `2026.1.3`. Each side
bumps only when it ships; the release commit names only the side(s)
being released.

No code changes were needed for the switch: the CI globs (`v*` /
`cli-v*`), the tag guard, and the `upgrade` numeric segment compare
all handle `YYYY.MINOR.MICRO` as-is (verified at adoption).

| | Web app | CLI |
|---|---|---|
| Manifest (single source) | `package.json` | `cli/package.json` (read statically by `cli/src/version.ts` — never regenerated) |
| Tag format | `vYYYY.MINOR.MICRO` (e.g. `v2026.1.0`) | `cli-vYYYY.MINOR.MICRO` (e.g. `cli-v2026.1.0`) |
| CI | `.github/workflows/publish.yml` (`publish-workers`) → GitHub release `lexa-workers-<tag>.tar.gz` + `checksums.txt` | `.github/workflows/publish-cli.yml` → GitHub release assets `lx` (binary) and, for one transition cycle, legacy `lexa-cli` |
| Changelog | `CHANGELOG.md` (root) | `cli/CHANGELOG.md` |
| Failure guard | — | `publish-cli.yml` fails if the tag doesn't match `cli/package.json` |

`install-cli.sh` and `lx upgrade` resolve the newest `cli-v*` tag via
the API — never `releases/latest`, which may be a web app release with no
CLI asset.

## Pre-tag checklist

1. **Both changelogs.** Before tagging, verify the new version has a dated
   section (`## [2026.1.0] - YYYY-MM-DD`, Keep a Changelog) in BOTH
   `CHANGELOG.md` and `cli/CHANGELOG.md` that cover their respective changes.
2. **Wireframes submodule.** Commit `wireframes/` changes INSIDE the
   submodule first; the parent release commit then records the new pointer.
   The submodule must be pushed for clones to resolve the pointer.
3. **Build artifacts.** `bun run compile:cli` produces `bin/lx` locally
   only — the shipped binary is built by `publish-cli.yml` from the tag.
   Nothing embed-related is committed (the daemon embed tier was
   removed 2026-09-26); `bin/` stays untracked.
4. **Gate.** `tsc --noEmit`, full `vitest run`, and `bash wireframes/build.sh`
   green before tagging. A push to the release-prep branch (`chore/release-*`
   / `release/*`) runs the full release CI (`.github/workflows/ci.yml`); a
   manual `workflow_dispatch` runs it on demand. PRs and main merges are gated
   by `bash scripts/verify-gate.sh` + review only.
5. **Tag the release commit.** Annotated only:
   `git tag -a v2026.1.0 -m "<one-line summary>"` and
   `git tag -a cli-v2026.1.0 -m "<one-line summary>"` (substitute the
   version being released).
6. **Release commit shape.** One
   `chore(release): v2026.1.0, cli-v2026.1.0` commit containing the version bumps
   + both changelog entries, then the tags.
7. **Push the release:** ensure `main` is pushed, then push the two annotated
   tags for the version being released (e.g. `git push origin v2026.4.0
   cli-v2026.5.0`). Both publish workflows are tag-triggered — an unpushed
   tag ships nothing.
8. **Verify the release:** `publish-workers` and `publish-cli` green on the
   tags; the `v<version>` release carries
   `lexa-workers-v<version>.tar.gz` + `checksums.txt`; the `cli-v<version>`
   release carries the `lx` asset (check the workflow for any legacy asset). The
   workflows' installer warm + smoke step covers the rest.

## Web app release flow

- `main` pushes publish nothing. Stable channels are tag-built; a main snapshot
  is a self-serve local build — `LEXA_FLAVOR=workers bun run build` from a
  checkout, then `scripts/install.sh workers --from-repo .` (see
  `docs/DEPLOYMENT.md`).
- `v*` tags → the `publish-workers` workflow (`.github/workflows/publish.yml`,
  job `release-tarballs`) builds the Workers flavor (`LEXA_FLAVOR=workers bun
  run build`) and attaches two assets to the GitHub release:
  `lexa-workers-<tag>.tar.gz` + `checksums.txt`.
- The tarball is the whole deploy artifact: `dist/` (the prebuilt worker
  bundle), `wrangler.jsonc` (placeholder `database_id` stripped), `migrations/`,
  and `scripts/workers-install.ts`, and `scripts/lib/cf-deploy.ts`. No image is built or published.
- Remote deploy uses `scripts/install.sh workers` (`curl -fsSL
  …/scripts/install.sh | bash -s -- workers [flags]`). It fetches the tarball
  by scanning the release list for the newest `v*` web-app tag (the `v[0-9]`
  anchor excludes `cli-v*`, and it never uses `releases/latest`, which a newer
  CLI release could win), verifies the tarball against `checksums.txt` when the
  release carries one that lists it (a release without `checksums.txt` unpacks
  unverified, with a warning; one whose `checksums.txt` omits the tarball aborts
  the install), then runs
  `scripts/workers-install.ts` — provisioning D1+R2+KV via the Cloudflare API,
  applying D1 migrations, and deploying the prebuilt bundle. Upgrade = re-run
  from a newer tag; the D1/R2/KV resources survive (keyed by `--name`).
- The `/setup` wizard's optional sample-data step is a local (Bun) install
  feature — `/api/setup/seed` has no `LXK_ENV` gate. On Workers, seed D1
  explicitly via `wrangler d1 execute --file`.
- Removing a deploy is `scripts/uninstall.sh workers`: D1/R2/KV are kept by
  default, and `--purge` removes local credentials (delete the resources from
  the Cloudflare dashboard) after a TTY confirmation that requires typing
  `purge`.
- The CLI `upgrade` command self-updates only the CLI binary; web app upgrades
  re-run `scripts/install.sh workers` with a newer tag (there is no `lx deploy` —
  see Deploy state below).

## CLI build flow

- `prod` = compiled binary. `bun run compile:cli` is a plain
  `bun build --compile --minify cli/src/index.ts` → `bin/lx`. No daemon embed
  (the agent-runtime tier was removed 2026-09-26), and the CLI installs no
  listener unit.
- `dev` = `bun run lx` or `bun run install:cli-dev` →
  `~/.local/bin/lx-dev` (a pure "run repo source via bun" wrapper —
  no `LEXA_DIR` export or flavor logic, identical behavior and state paths
  to the compiled binary; never overwrites the prod name).

## Deploy state + creds

**There is no CLI deploy state.** `lx deploy` / `lx undeploy` were removed in
cli-v2026.2.0 — `lx` is operate-only. Self-hosting goes through
`scripts/install.sh workers` (`curl -fsSL …/scripts/install.sh | bash -s -- workers`,
upgrade = re-run from a newer tag) plus the `/setup` wizard for the first
superadmin.

What the CLI still persists: the saved login (endpoint + `lxk_` key) under
`~/.lexa/`, overridable per-shell with `LEXA_URL` + `LEXA_API_KEY`. Keys are
minted in the web app (Settings → API Keys) or by `lx login`'s device flow.
Release-relevant credentials: `CF_API_TOKEN` (Workers target only) lives in the
env file, not in CLI state.

## Install without bun

On a machine without bun, install the CLI binary via:

```bash
curl -fsSL https://raw.githubusercontent.com/yohanesgre/lexa/<cli-tag>/scripts/install-cli.sh | bash
```

Downloads the prebuilt binary from the newest `cli-v*` GitHub release →
`~/.local/bin/lx`.
