# Wiki Share Links — Design Spec

Date: 2026-08-21 · Status: approved scope, pending implementation
Companion plan: `docs/superpowers/plans/2026-08-21-wiki-share-links.md`

## Problem Statement

Lexa's wiki is workspace-only: reading a page requires an account. Sharing a doc with someone outside the workspace (client, contractor, collaborator) means provisioning a user — heavy for read-only access. Lexa is self-hosted behind a cloudflared tunnel, so "send a link" must be backed by an explicit, revocable authorization object, not ambient access.

## Goals

1. A project editor can share any wiki page via URL in under 30 seconds, no admin involvement.
2. Anyone with the link can read the target page and navigate its descendant pages — no account, no login.
3. Links are revocable instantly and support an optional expiry date, enforced server-side.
4. The public surface is limited to token-scoped read of exactly one page subtree — nothing else is reachable.

## Non-Goals

- **No editing or commenting** by anonymous viewers — strictly read-only.
- **No password-protected links** — token entropy is the protection; revisit if needed.
- **No per-descendant exclusion** — a link exposes the whole subtree or nothing.
- **No sharing for tasks/kanban** — wiki only this iteration.
- **No access analytics/counters** in v1 (parking lot, see P2).

## User Stories

- As a **project editor**, I want a Share button on a wiki page so that I can generate a public link without leaving the viewer.
- As a **project editor**, I want to set an optional expiry when creating a link so that temporary collaborations end automatically.
- As a **project editor**, I want to see all active links for a page and revoke any of them so that exposure stays under my control.
- As an **external viewer**, I want to open the shared URL and read the doc, navigating between its child pages, without creating an account.
- As an **external viewer** with an expired or revoked link, I want a plain not-found response so that I know the link is dead (and cannot probe which).
- As a **workspace owner**, I want public access limited to one subtree per token so that a leaked link exposes minimal content.

## Requirements

### Must-Have (P0)

**R1 — Share dialog (UI).** Share button in the wiki page viewer toolbar (next to Edit). Dialog: create link with optional expiry date, list of existing links (created date, expiry, revoke action), copy-to-clipboard. Built from PHOSPHOR primitives verbatim (`docs/design-system.html`); wireframe-first (`wireframes/src/`, then `bash wireframes/build.sh`).
- [ ] Wireframe exists and builds before React implementation
- [ ] Dialog matches wireframe structure/copy exactly; tokens only, no raw hex outside `phosphor.css`

**R2 — Link creation.** `POST /api/projects/:slug/wiki/pages/:pageSlug/share` (project-editor auth). Body: `{ expiresAt?: ISO-8601 }`. Returns link record incl. URL `${PUBLIC_URL}/share/<token>`. Token: `randomBytes(18).toString("base64url")`, stored plaintext UNIQUE (invite/password-link precedent). Multiple links per page allowed.
- Given an editor creates a link without expiry
- When they open the returned URL logged out
- Then the page renders read-only
- Given expiry set in the past
- When the link is opened
- Then generic 404 (identical envelope to unknown/revoked)

**R3 — Link management.** `GET …/share` lists links for the page; `DELETE /api/projects/:slug/wiki/share/:linkId` revokes (row delete — immediate). Only project editors may call these.

**R4 — Public read endpoint.** `GET /api/share/:token` — no auth (middleware AUTH-exempt path predicate), still IP-rate-limited with a dedicated stricter bucket, security headers kept. One request returns root page + full descendant subtree (titles/slugs/tree + TipTap JSON content). Missing/expired/revoked → identical generic 404 (no existence oracle). Handler must not consume `AuthIdentity` (exempt paths receive synthetic admin identity — known trap).
- Given a valid token for a page with children
- When fetched unauthenticated
- Then response contains root content and all descendants' content
- Given a child page is added after sharing
- When the link is re-fetched
- Then the new child appears (tree resolved at read time)

**R5 — Public view route.** `/share/:token` frontend route, no app chrome/nav. Renders TipTap JSON via existing `app/components/tiptap-render.tsx` (safe-href allowlist already enforced). Child-page navigation within the shared view only.
- Given rendered shared content containing a `javascript:` href attempt stored in the doc
- When rendered
- Then scheme allowlist blocks it

**R6 — Schema.** New table `wiki_share_links`: `id TEXT PK`, `page_id FK→wiki_pages ON DELETE CASCADE`, `token TEXT UNIQUE NOT NULL`, `expires_at TEXT NULL`, `created_by FK users`, `created_at`/`updated_at`. Migration `migrations/0008_wiki_share_links.sql`.

**R7 — Docs first.** `docs/SCHEMA.md`, `docs/LAYERS.md` (service graph + error catalog: `ShareLinkNotFound` → 404), `docs/API.md` updated before code lands (document authority rule).

### Nice-to-Have (P1)

None — scope kept tight for v1.

### Future Considerations (P2)

- Password-protected links
- Access counters / last-viewed per link
- Per-descendant exclusion
- Task/board sharing

## Constraints & Invariants Carried Into Implementation

- REST boundary speaks TipTap JSON (invariant 7) — no Markdown conversion anywhere in this feature.
- Mutation responses authoritative; cache updates via `setQueryData` (invariant 6).
- Repos thin (raw bun:sqlite prepared statements); services are `Effect.Service`; routes thin; errors mapped via `server/api/errors.ts` catalogs.
- Descendant resolution: recursive CTE over `wiki_pages(parent_id)`; deterministic, read-time.
- No commits unless user explicitly asks; gates: `bunx tsc --noEmit`, `vitest run`, `bash wireframes/build.sh`.

## Success Metrics

Internal tool — success = acceptance criteria above pass plus:
- Zero unauthenticated 5xx on `/api/share/*` under manual abuse smoke (bad tokens, oversized paths).
- Negative tests prove expired/revoked/unknown links are indistinguishable.

## Open Questions

None blocking — all product decisions resolved (public access, subtree scope, multiple links, editors-only, one-request payload, optional expiry).
