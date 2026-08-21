# Wiki Share Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Public, revocable share links for wiki pages — anyone with the URL reads the page and its descendants, no login.

**Architecture:** New `wiki_share_links` table (token = capability). `WikiShareRepo` (thin SQL incl. recursive-CTE subtree read) under a new `WikiShareService` mapped into the error catalog. Three authed endpoints on the existing wiki group + one public `GET /api/share/:token` via an AUTH-exempt middleware predicate that keeps rate limiting and security headers. Frontend: Share dialog in the wiki viewer + bare `/share/:token` route rendering through the existing read-only TipTap renderer.

**Tech Stack:** Bun + Effect-TS (`Effect.Service`), bun:sqlite prepared statements, @effect/platform HttpApi, TanStack Start/Query, PHOSPHOR design system, wireframes submodule.

**Spec:** `docs/superpowers/specs/2026-08-21-wiki-share-links-design.md`

## Global Constraints

- NO git commits anywhere in this plan (commits only on explicit user request).
- Every task gate: `bunx tsc --noEmit` passes.
- REST boundary speaks TipTap JSON — no Markdown conversion in this feature (invariant 7).
- Mutation responses authoritative; cache updates via `setQueryData`, never `invalidateQueries` on the mutation path (invariant 6).
- Repos are thin: raw bun:sqlite prepared statements, `updated_at = datetime('now')` inside every UPDATE.
- Services are `Effect.Service<Name>()("Lexa/Name", { effect: Effect.gen(...) })`; domain errors are `Data.TaggedError`; new errors register in ALL maps in `server/api/errors.ts` (`errorCodeMap`, `errorToStatus`, `errorMessage`) — not `.addError`.
- Names exact: table `wiki_share_links`, repo `WikiShareRepo` ("Lexa/WikiShareRepo"), service `WikiShareService` ("Lexa/WikiShareService"), error `ShareLinkNotFound` → code `SHARE_LINK_NOT_FOUND` → 404.
- Public endpoint: missing/expired/revoked tokens return the IDENTICAL generic 404 envelope (no existence oracle). The public handler must NOT consume `AuthIdentity` (exempt paths receive synthetic `role:"admin"` identity — `server/api/middleware.ts:122-124`).
- Editor authorization = same gate as all wiki handlers today: `requireProjectRead(slug)` (`server/api/http.ts:1394-1404`). Do not invent a role model.
- Token: `randomBytes(18).toString("base64url")` (password-links precedent); stored plaintext UNIQUE; expiry normalized to UTC ISO-8601 and compared lexically server-side.
- UI: consult `docs/design-system.html` first, copy primitive markup verbatim; CSS variables only, no raw hex outside `phosphor.css`. Wireframe tasks complete before any React implementation task starts.
- Wireframes: edit `wireframes/src/` only, never `dist/`; run `bash wireframes/build.sh` after edits; notes as `<span class="annotation">` / `<span class="annotation-tag">`.

---

### Task 1: Design docs (SCHEMA / LAYERS / API)

**Files:**
- Modify: `docs/SCHEMA.md` (wiki section, after `wiki_page_revisions`)
- Modify: `docs/LAYERS.md` (layer diagram :5-31, error catalog rows :760-792, service dependency map :794-816)
- Modify: `docs/API.md` (error catalog table :32-74, Wiki endpoints section :870-915)

**Interfaces:**
- Produces (canonical names every later task uses): table `wiki_share_links`; errors `ShareLinkNotFound`(404); endpoints `POST|GET /api/projects/:slug/wiki/pages/:pageSlug/share`, `DELETE /api/projects/:slug/wiki/share/:linkId`, `GET /api/share/:token`.

- [ ] **Step 1: Add DDL to SCHEMA.md** — copy formatting style from the neighboring wiki tables verbatim:

```sql
CREATE TABLE wiki_share_links (
  id          TEXT PRIMARY KEY,
  page_id     TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  token       TEXT NOT NULL UNIQUE,
  expires_at  TEXT,
  created_by  TEXT REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Add data-invariant note: expiry is UTC ISO-8601 or NULL (never expires); revocation is row deletion; deleting a page cascades its links; public reads resolve the descendant tree at request time.

- [ ] **Step 2: LAYERS.md** — add `WikiShareService → WikiShareRepo, WikiRepo` to the dependency map; add catalog row: `ShareLinkNotFound` → `SHARE_LINK_NOT_FOUND` → 404. Note the AUTH-exemption + stricter-bucket rule for `/api/share/*`.
- [ ] **Step 3: API.md** — document the four endpoints with exact request/response shapes (see Task 4/5 Interfaces) and add the error-catalog row.
- [ ] **Step 4: Gate** — `bunx tsc --noEmit` (no code changed; confirms clean baseline).

---

### Task 2: Migration 0008 + WikiShareRepo

**Files:**
- Create: `migrations/0008_wiki_share_links.sql`
- Create: `server/repos/wiki-share.repo.ts`
- Test: `server/repos/wiki-share.repo.test.ts`

**Interfaces:**
- Consumes: `Sqlite` service tag (same as `server/repos/wiki.repo.ts`); migrations runner `runMigrations(dbPath, migrationsDir)` from `server/db/migrate.ts`.
- Produces:

```ts
export interface WikiShareLinkRow {
  id: string; page_id: string; token: string;
  expires_at: string | null; created_by: string | null;
  created_at: string; updated_at: string;
}
export class WikiShareRepo extends Effect.Service<WikiShareRepo>()("Lexa/WikiShareRepo") {
  // insert(link): Effect<void, DbError>
  // listByPage(pageId): Effect<WikiShareLinkRow[], DbError>
  // deleteById(id): Effect<boolean, DbError>
  // findByToken(token): Effect<WikiShareLinkRow | null, DbError>
  // findSubtreeRows(pageId): Effect<SubtreeRow[], DbError>
}
```

- [ ] **Step 1: Write migration** `migrations/0008_wiki_share_links.sql` — DDL exactly as Task 1 Step 1.
- [ ] **Step 2: Write failing repo test** — harness mirrors `server/repos/wiki.repo.test.ts`: tmpdir SQLite, `runMigrations(dbPath, fileURLToPath(new URL("../../migrations", import.meta.url)))`. Cover: insert + listByPage ordering; deleteById returns true once then false; findSubtreeRows returns root + nested descendants via CTE; cascade — deleting a wiki page removes its links.
- [ ] **Step 3: Run** `bunx vitest run server/repos/wiki-share.repo.test.ts` — expect FAIL (module missing).
- [ ] **Step 4: Implement repo** — mirror `wiki.repo.ts` structure exactly. Subtree SQL:

```sql
WITH RECURSIVE subtree(id) AS (
  SELECT id FROM wiki_pages WHERE id = ?
  UNION ALL
  SELECT wp.id FROM wiki_pages wp JOIN subtree s ON wp.parent_id = s.id
)
SELECT id, parent_id, title, slug, content, updated_at
FROM wiki_pages WHERE id IN (SELECT id FROM subtree)
```

Assemble the tree in TS (parent map), not SQL. All statements prepared once in the service constructor like neighboring repos.
- [ ] **Step 5: Run test again** — expect PASS. Gate: `bunx tsc --noEmit`.

---

### Task 3: WikiShareService

**Files:**
- Create: `server/services/wiki-share.service.ts`
- Create: `server/errors/wiki-share-errors.ts` (or wherever sibling domain errors live — match `SlugTaken`/`WikiPageNotFound` location)
- Test: `server/services/wiki-share.service.test.ts`

**Interfaces:**
- Consumes: `WikiShareRepo.Default`, `WikiRepo.Default` (page existence check), `randomBytes` from `node:crypto`.
- Produces:

```ts
export class ShareLinkNotFound extends Data.TaggedError("ShareLinkNotFound")<{}> {}
export class WikiShareService extends Effect.Service<WikiShareService>()("Lexa/WikiShareService") {
  // create(input: { projectId: string; pageId: string; expiresAt: string | null; createdBy: string })
  //   : Effect<WikiShareLinkRow, WikiPageNotFound | DbError>   // validates page belongs to project; normalizes expiresAt to UTC ISO; token randomBytes(18).toString("base64url"); id crypto.randomUUID()
  // list(pageId: string): Effect<WikiShareLinkRow[], DbError>
  // revoke(linkId: string): Effect<void, ShareLinkNotFound | DbError>
  // resolvePublic(token: string)
  //   : Effect<{ root: SharedPageNode }, ShareLinkNotFound | DbError>
}
export interface SharedPageNode {
  id: string; title: string; slug: string;
  content: unknown;            // parsed TipTap JSON
  updatedAt: string;
  children: SharedPageNode[];
}
```

- [ ] **Step 1: Register error** — `Data.TaggedError` class + entries in `errorCodeMap` (`SHARE_LINK_NOT_FOUND`), `errorToStatus` (404), `errorMessage` in `server/api/errors.ts` (mirror how `WikiPageNotFound` is registered).
- [ ] **Step 2: Write failing service tests** — mirror `wiki.service.test.ts` style: create returns row with base64url token matching `/^[A-Za-z0-9_-]{24}$/`; create against page of another project → `WikiPageNotFound`; expired link → `resolvePublic` fails `ShareLinkNotFound`; revoked → same; valid → tree contains root + descendants with parsed JSON content; NULL expiry never expires.
- [ ] **Step 3: Run** `bunx vitest run server/services/wiki-share.service.test.ts` — expect FAIL.
- [ ] **Step 4: Implement** — `resolvePublic`: `findByToken` → null OR `expires_at !== null && expires_at <= new Date().toISOString()` → `ShareLinkNotFound` (identical failure path — no oracle); else `findSubtreeRows(link.page_id)` → build `SharedPageNode` tree (`JSON.parse(content)`, empty doc `{}` tolerated). Map repo `ConstraintViolation` on insert to retry-free `DbError` (token collision probability negligible; surface as `DbError`).
- [ ] **Step 5: Run again** — PASS. Gate: `bunx tsc --noEmit`.

---

### Task 4: Authed share-link endpoints

**Files:**
- Modify: `server/api/http.ts` (wikiGroup declaration ~:1223-1243; handlers near `wikiLive` ~:2834-2947; register `WikiShareService.Default` in `buildServiceLayer` ~:3184-3239)
- Modify: `app/lib/api.ts` (~:282-318, wiki client fns) — frontend client fns only, no hooks yet
- Test: `server/api/http-wiki-share.test.ts`

**Interfaces:**
- Consumes: `requireProjectRead(slug)` gate; `WikiShareService`; `PUBLIC_URL` export (`server/auth.ts:9`).
- Produces (exact contract, also what API.md documents):

```
POST /api/projects/:slug/wiki/pages/:pageSlug/share
  body { "expiresAt": "2026-09-30T00:00:00.000Z" }   // or {} / omitted = never
  201 { "link": { "id", "url", "expiresAt", "createdAt" } }
      url = `${PUBLIC_URL}/share/${token}`           // token itself NEVER returned after create
GET  /api/projects/:slug/wiki/pages/:pageSlug/share
  200 { "data": [ { "id", "url", "expiresAt", "createdAt" } ] }
DELETE /api/projects/:slug/wiki/share/:linkId
  204                       // match neighboring DELETEs — respond(undefined) → 204
  404 SHARE_LINK_NOT_FOUND
```

- [ ] **Step 1: Write failing route tests** — copy harness from `http-wiki-admin.test.ts` (tmpdir SQLite + seed SQL + `createApiHandler(dbPath)` + `json(method, path, body, key)` helper). Cases: editor creates link (201, url starts with PUBLIC_URL + `/share/`); non-member project slug → 403; list shows created link; delete revokes → subsequent public resolution would fail (asserted via service in Task 5 tests); delete unknown id → 404 envelope code `SHARE_LINK_NOT_FOUND`.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** — three endpoints added to `wikiGroup` with Schema payloads (`expiresAt` optional string → `null` when absent); each handler: `requireProjectRead(slug)` → resolve page via existing wiki lookup path → call service → return via `respond()` wrapper mirroring neighbor handlers. Build URL with `PUBLIC_URL`. Register `WikiShareService.Default` in `buildServiceLayer`.
- [ ] **Step 4: Add client fns** in `app/lib/api.ts`: `createWikiShareLink(slug, pageSlug, expiresAt?)`, `listWikiShareLinks(slug, pageSlug)`, `revokeWikiShareLink(slug, linkId)` — mirror neighboring wiki fns.
- [ ] **Step 5: Run** — PASS. Gate: `bunx tsc --noEmit`.

---

### Task 5: Public endpoint + middleware exemption + stricter bucket

**Files:**
- Modify: `server/api/middleware.ts` (AUTH-exempt path predicates ~:47-54; rate-limit wiring)
- Modify: `server/api/http.ts` (new top-level group or endpoint for `GET /api/share/:token`; handler must not touch `AuthIdentity`)
- Test: `server/api/http-wiki-share-public.test.ts`
- Test: `server/api/rate-limit.test.ts` (extend: dedicated bucket)

**Interfaces:**
- Consumes: `WikiShareService.resolvePublic(token)`.
- Produces:

```
GET /api/share/:token          // unauthenticated
200 { "root": SharedPageNode } // shape from Task 3
404 { "error": { "code": "SHARE_LINK_NOT_FOUND", ... } }   // missing == expired == revoked
429 on bucket exhaustion
```

- [ ] **Step 1: Write failing tests** — same route harness, requests WITHOUT Authorization header: valid token → 200 with root + children content; unknown token → 404 `SHARE_LINK_NOT_FOUND`; expired → identical status+code+envelope-shape as unknown (assert deep equality of error bodies modulo message text); revoked → identical; burst > bucket max → 429.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement endpoint** — declare on `LexaApi` (sibling of wiki group, still under `.prefix("/api")`); handler calls ONLY `WikiShareService.resolvePublic` — no `AuthIdentity` consumption, no project gate.
- [ ] **Step 4: Middleware** — add literal predicate `path.startsWith("/api/share/")` to the AUTH-skip set (alongside `/api/setup*`, `/api/health` — still inside apiHandler so rate limit + security headers apply). Add dedicated limiter via `createRateLimiter({ max, windowMs })` (stricter than default IP bucket; pick e.g. 30 req/min/IP — tune constant in one place) applied to `/api/share/*` before auth stage.
- [ ] **Step 5: Run both test files** — PASS. Gate: `bunx tsc --noEmit`.

---

### Task 6: Wireframes (gate before any React work)

**Files:**
- Create: `wireframes/src/wiki-share.html` (Share dialog states: create form w/ optional expiry date input, link list w/ created/expiry/revoke, copied feedback)
- Create: `wireframes/src/wiki-shared.html` (public read view: page content + child-page nav, no app chrome, not-found state for dead links)
- Modify: `wireframes/src/index.html` (add both to the browse index)

**Interfaces:**
- Consumes: modal/dialog primitives from `docs/design-system.html` (copy markup verbatim); button/input/badge primitives; existing `wiki.html` toolbar structure (:91-99 Edit-button area).
- Produces: the visual authority Tasks 7-8 transcribe.

- [ ] **Step 1: Open `docs/design-system.html`**, identify dialog, button, input, badge primitives.
- [ ] **Step 2: Author `wiki-share.html`** — trigger button next to Edit in viewer toolbar; dialog with: link list rows (URL truncated, created date, expiry badge or "Never", Revoke), create row (expiry date input optional), Copy action with copied state. All behavior specs as annotation spans.
- [ ] **Step 3: Author `wiki-shared.html`** — minimal header (doc title + "Shared read-only" badge), rendered-content placeholder using wiki typography, child-pages nav list, dead-link not-found state. Annotations for: no app chrome, navigation limited to subtree.
- [ ] **Step 4: Update `index.html`**, run `bash wireframes/build.sh` — must exit green; verify compiled files appear in `wireframes/dist/`.
- [ ] **Step 5: Gate** — `bunx tsc --noEmit` (baseline sanity).

---

### Task 7: Share button + dialog + query hooks

**Files:**
- Modify: `app/styles/phosphor.css` (port any NEW classes introduced by the wireframes — none may exist yet)
- Modify: `app/components/wiki/WikiPageViewer.tsx` (toolbar `PageViewHeader`, next to Edit ~:52-62)
- Create: `app/components/wiki/ShareDialog.tsx` (transcribe `wiki-share.html`; modal shell mirrors `NewPageModal.tsx` `dialog-overlay` + `dialog dialog-enter` pattern)
- Modify: `app/lib/queries.ts` (hooks after wiki block ~:468-562)
- Test: `app/components/wiki/ShareDialog.test.tsx`

**Interfaces:**
- Consumes: Task 4 client fns; wireframe markup (authority).
- Produces:

```ts
useWikiShareLinks(slug: string, pageSlug: string)   // ["wikiShareLinks", slug, pageSlug]
useCreateWikiShareLink(slug, pageSlug)              // setQueryData merges new link into list cache
useRevokeWikiShareLink(slug, pageSlug)              // setQueryData filters revoked id out
```

- [ ] **Step 1: Port CSS** — diff wireframe CSS vs `phosphor.css`; port only genuinely new classes; variables only.
- [ ] **Step 2: Write failing component test** — render dialog with mocked hooks: lists links, create calls mutation with expiry value, revoke calls mutation, copy writes clipboard.
- [ ] **Step 3: Run** — FAIL.
- [ ] **Step 4: Implement** — Share button in `PageViewHeader`; `ShareDialog` transcribes wireframe structure/copy exactly (no extra padding/treatments); hooks per signatures above using `setQueryData` only.
- [ ] **Step 5: Run** — PASS. Gate: `bunx tsc --noEmit`.

---

### Task 8: Public /share/:token route

**Files:**
- Create: `app/routes/share.$token.tsx`
- Test: `app/routes/share.$token.test.tsx`

**Interfaces:**
- Consumes: `GET /api/share/:token` (plain `fetch` — NO auth header, do NOT route through the keyed api client wrapper); `renderDoc(doc, "wiki")` from `app/components/tiptap-render.tsx` (safe-href guard built in); bare-page layout approach from `app/routes/invite.tsx` (existing keyless public page).
- Produces: route `/share/:token` — renders root content + child nav within subtree only; dead link → not-found state per `wiki-shared.html`.

- [ ] **Step 1: Write failing test** — mock fetch: 200 payload renders title + content nodes + children links; 404 renders not-found state; child link navigates to same route with selected child rendered.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — transcribe `wiki-shared.html` (header badge, typography, nav); loader fetches `/api/share/${token}`; render via `tiptap-render`; child selection re-fetches cached tree (single payload — no extra network per child).
- [ ] **Step 4: Run** — PASS. Gate: `bunx tsc --noEmit`.

---

### Task 9: Full verification

- [ ] `bunx tsc --noEmit` — clean.
- [ ] `bunx vitest run` — full suite green.
- [ ] `bash wireframes/build.sh` — green.
- [ ] Manual smoke (`bun run dev:full`): logged in as editor — open wiki page, Share → create link w/o expiry → copy URL; log out (or incognito) → open `${PUBLIC_URL}/share/<token>` → page renders, child pages navigate; back as editor → create second link with past expiry → incognito refresh → generic not-found; revoke first link → incognito → generic not-found; confirm no other wiki/project routes reachable from shared view.
- [ ] Report results; wait for explicit user instruction before any commit.

---

## Self-Review (done at authoring time)

- Spec coverage: R1→Task 6+7 · R2→Tasks 3,4 (+URL build) · R3→Task 4 · R4→Task 5 · R5→Task 8 · R6→Task 2 · R7→Task 1. No gaps.
- No placeholders; every code step has concrete code or an exact named neighbor file to mirror.
- Name consistency: `wiki_share_links` / `WikiShareRepo` / `WikiShareService` / `ShareLinkNotFound` / `SHARE_LINK_NOT_FOUND` used identically across all tasks.
