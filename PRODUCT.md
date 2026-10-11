# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary: a small team (2–10 people) that runs its own tracker — general project management, not a vertical.** Lexa is **not** a game-development product: the owner's own project happens to be game development, which makes that one real use case among many, never the product's definition. What users have in common is scale and posture, not industry — they are the team that would otherwise sit on a hosted Jira/Linear/Trello, they work with an editor and a terminal open, and the tracker sits beside that work for hours at a time. Signals that matter to them: who is on a card, whether the work is in flight, what moved, what is blocked, and what shipped. Product roles: a superadmin (env-configured) who provisions, per-team owners/admins, and members. The AI Assistant is part of this app's surface for those teams, not a separate product.

## Product Purpose

Lexa is a self-hosted project-management tool: a Kanban board with swimlanes and WIP limits, rich
tasks, a nested wiki, milestones, an AI Assistant (Cloudflare Workers deploys), team auth, and two-way GitHub issue sync.
It exists so a small team owns its work data and its integration surface outright — deployed into
its own account, operated by teammates and by scripts.

Success looks like: the board is where the team actually looks first (dense enough to hold a real
backlog at 1080p), issue state on GitHub and board state never disagree, and a script or an agent
can read and write the same objects a human sees in the UI.

## Positioning

**Your tracker, your Cloudflare account, agent-operable.** Three things together, which a hosted
neighbour could not truthfully copy: self-hosting on the team's own Cloudflare account (D1 + R2 +
KV) with a local Bun + SQLite flavour for day-to-day work; real two-way GitHub issue sync with
echo suppression and a column↔issue-state mapping; and a headless operator surface — the `lx` CLI
plus `lxk_` API keys — that external scripts and agents drive.

## Operating Context

- Self-hosted: `scripts/install.sh` provisions Cloudflare Workers (D1 + R2 + KV) and deploys the
  prebuilt Worker; local development runs the Bun + SQLite flavour (`bun run setup`, `bun run dev`
  → API :3000 + vite :5173, or `bun run dev:workers` for the Worker flavour on :5173).
- Cloudflare Workers is the only deploy target, and the AI Assistant exists only there.
- Teams are intra-server workspaces (Better Auth organizations); projects carry a `team_id`. A
  team-scoped project is never silently re-teamed.
- Human auth is in-process email/password with cookie sessions — no Cloudflare Access, no public
  signup; provisioning is admin-curated via workspace invites and set-password links.
- GitHub is connected from the app (Settings → Workspace → Integrations → GitHub Sync); the webhook
  is authenticated by HMAC-SHA-256 over the raw body.
- Work is planned as Backlog + sprints (swimlanes), with milestones above sprints.

## Capabilities and Constraints

Confirmed capability: Kanban with swimlanes/sprints, WIP limits, drag reorder, archive/restore,
per-project priority/type configuration, required-field gates, immutable ticket keys; tasks with
TipTap descriptions, assignees, activity timeline, comments, attachments, subtask/blocked-by/
related links; nested wiki with full-text search, revisions and restore, public share links;
milestones with target dates, progress and timeline; streaming AI Assistant with threads,
review-in-editor generation, multi-provider gateway and an approval flow for task/wiki writes;
email/password auth with teams, roles, invites and API keys; two-way GitHub issue sync; the `lx`
operator CLI.

Durable constraints (must survive future work):

- Deploy target is Cloudflare Workers (D1 + R2 + KV) only; the locally-run flavour is Bun + SQLite.
  The AI Assistant is Workers-only.
- No public signup: the first superadmin comes from the setup wizard, everyone else from invites.
- Exactly one Backlog per project; it can neither be archived nor deleted.
- Ticket keys are immutable (`projects.key` + `tasks.number`, written once, never reused).
- The fourteen architectural invariants in `AGENTS.md` are constraints, not preferences.
- Design tokens are PHOSPHOR CSS variables; no raw hex outside `app/styles/phosphor.css`.
- `lx` is operate-only — no deploy commands.

Explicitly undecided / not established at init: pricing or licensing posture beyond the repo's
current licence, a hosted multi-tenant offering, native mobile apps, and any second deploy target.

## Brand Commitments

- Name: **Lexa**. The CLI is `lx`.
- The design system is named **PHOSPHOR** (warm phosphor workspace: amber-tinted darks, a small
  disciplined signal palette, three type voices, density as the working loop).
- Brand assets: the LX monogram (`lexa-mark.svg`) and favicon (`lexa-favicon.svg`). They currently
  live in the wireframes submodule's `src/assets/` and **must be moved into this repo before that
  submodule is removed**.
- Voice in the product is plain and functional; no marketing claims are established as binding.

## Evidence on Hand

- Product documentation: `README.md`, `docs/ARCHITECTURE.md`, `docs/SCHEMA.md`, `docs/LAYERS.md`,
  `docs/API.md`, `docs/GITHUB_SETUP.md`, `docs/DEPLOYMENT.md`, `docs/RELEASING.md`.
- Primitive reference: `docs/design-system.html` (canonical component markup + tokens).
- Sample/dev data: `scripts/seed-dev.sql` (seeded in `dev` and `staging` only).
- Real usage evidence: the repository itself, its CHANGELOG, and the `lx` CLI.

Absences future work must not fabricate: there are no customer testimonials, no benchmarks, no
uptime or performance claims, no pricing figures, and no press. Any such content would be invented.

## Product Principles

1. **Self-hosting is the product, not a deployment mode.** Data, integrations, and the operator
   surface stay inside the team's own account.
2. **Density is the working loop.** The board must hold a real backlog at 1080p without scrolling
   before it looks generous; a tracker you stare at for hours earns its space.
3. **State is signal, never decoration.** Colour, position, and motion communicate priority, type,
   WIP state, and sync state — a surface that renders state ambiguously is a defect.
4. **Two systems, one truth.** Board state and GitHub issue state must never disagree silently;
   echo suppression and explicit out-of-sync surfacing are requirements, not polish.
5. **Everything a human can do, a script can do.** The CLI and API are first-class peers of the UI.

## Accessibility & Inclusion

Product-level requirement carried by the design system: WCAG AA contrast for text, full keyboard
operability with visible focus, reduced-motion support as a first-class path rather than a degraded
one, and tap targets that stay usable on small screens. No product-specific user need beyond that
has been established.
