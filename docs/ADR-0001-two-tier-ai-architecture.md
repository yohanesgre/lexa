# ADR-0001: Two-tier AI architecture — Herald and Blacksmith under Hearth

- **Status:** Accepted (amended 2026-08-23 — Hearth refactor: umbrella rename,
  two-agent catalog, engine switching, vision chain)
- **Date:** 2026-08-22
- **Implementation plan:** `docs/HERALD_PLAN.md`
- **Related research:** `docs/CLOUDFLARE_WORKERS.md`

## Context

Hearth (formerly the Forge umbrella — UI/docs/wireframes renamed this cycle;
internal identifiers `forge_tasks`/`forge_sessions`/`/api/forge/*`/`FORGE_*`/
CLI are deferred) — the AI assistant surface — executed every generation
through the
opencode harness: web app → `forge_tasks` queue → CLI listener → daemon → warm
`opencode serve` driven over private HTTP. This bought real things (agentic file
access, provider-subscription auth, sandboxing) at a structural cost:

- Assistants required operator-machine infrastructure (listener, daemon, ports,
  sandbox) — a fresh deployment had no working assistant until a machine was set up.
- Every assistant feature paid the "harness tax": model pickers, multimodal
  input, memory, or streaming each meant daemon payload and serve-behavior
  negotiation instead of a direct API call.
- The assistant use case (writing + project-management help) never needed what
  the harness provides. Deny-rules already stripped bash/webfetch/skills — the
  harness was acting as an expensive sealed text generator.
- Research (Aug 2026) showed TanStack AI (beta) covers the drive layer
  headless: `chat()` with custom OpenAI-/Anthropic-compatible endpoints,
  streaming, tool definitions, persistence middleware — verified against source.

## Decision

Split AI execution into two active, co-existing tiers under the **Hearth**
umbrella:

1. **Herald** — writing + PM assistant. Server-side TanStack AI `chat()`
   against a per-project custom OpenAI-/Anthropic-compatible endpoint
   (`herald_settings`). Prompt-assembled context (catalog markdown, prefetched
   repo content, document context, `project_memory` FTS5). Tools v1 are
   server-side reads only (`web_search` via Exa, SSRF-guarded `fetch_url`,
   `read_s3_file` via `Lexa/Storage`, PM reads); write tools deferred until
   approval UX exists. Threads in `herald_threads` (ModelMessage[] JSON,
   rolling summary replaces auto-compaction). Freeform **Herald Chat** surface
   runs the same engine without the task queue.
2. **Blacksmith** — coding tier. The existing listener/daemon/opencode runtime
   path, unchanged and active. Harness capabilities (shell, file edits,
   sandboxes) remain here deliberately.

Shared: the `forge_tasks` queue (Herald tasks ride it via a `kind` discriminator
— daemons can never claim them), and the catalog, renamed **Lexa Agents/Skills**
(`lexa_agents`/`lexa_skills`/`lexa_agent_skills`) because it is the behavioral
spec for both tiers: prompt injection renders it for Herald; `.agents/` file
writing renders it for Blacksmith. Claim-payload field names are frozen for
daemon wire compatibility.

## Amendments (2026-08-23 — Hearth refactor)

1. **Two-agent catalog with id rebind.** Exactly two builtin agents:
   `hearth-herald` ("Herald Agent") and `hearth-blacksmith` ("Blacksmith
   Agent") — same PM-assistant role, different execution architecture. The
   generic `lexa` entry is retired. Migration 0013 gives Herald Agent a NEW
   internal id and rebinds `forge_tasks.agent_id` FKs + junction rows
   atomically. One-time consequence: existing threads keyed on agentId reset
   once (continue-vs-fresh sees an unknown agentId → fresh overwrite).
2. **Per-project engine switching.** `herald_settings.engine` ∈
   `'herald'|'blacksmith'` applies to document threads + Generate; enqueue
   branches on it (kind row + runtime-online guard for blacksmith). Freeform
   chat ALWAYS runs the herald lane — under engine='blacksmith' chat returns
   409 `ENGINE_NOT_SUPPORTED_FOR_CHAT`.
3. **Personal-overlay toggle.** The member-facing engine toggle is a
   client-side session preference — it never writes the project default;
   `engine` is admin-written only. The toggle renders only when
   `engine_switcher_enabled=1`.
4. **Skills via junction.** Per-agent skill availability = existing
   `lexa_agent_skills` junction rows, admin-editable — no JSON columns.
5. **Vision chain.** `primarySupportsImages` is an explicit checkbox driving
   the vision chain: primary supports images → inline image parts; else a
   configured `vision_model` → internal `analyze_image` tool delegation
   (tool frame suppressed from member UI); else attachments are rejected up
   front with 409 `VISION_NOT_CONFIGURED`.
   *Amendment:* vision merged into the provider config — delegation runs on
   the primary provider (same kind/api_key/base_url), only the model
   differs. No separate vision credentials or cross-provider vision.

## Alternatives considered

- **Status quo (harness-only assistants):** rejected — every planned assistant
  capability costs 5–10× more through the daemon indirection; deployments stay
  machine-dependent.
- **Vercel AI SDK:** rejected — equivalent composition; TanStack AI chosen for
  native AG-UI protocol, Start integration, per-activity adapters, and existing
  stack alignment. Contained behind `Lexa/Herald` so swapping stays cheap.
- **Lighter harness (minimal ACP agent):** rejected — still process
  infrastructure for a workload that needs none.
- **Rip-and-replace Blacksmith:** rejected — coding genuinely needs the
  harness; its removal was never on the table.

## Consequences

**Positive**

- Assistant features ship with the web app: deploy = image + one settings row.
- Token streaming, tools, memory, and multimodal become direct API surface.
- Provider/vendor swap is a settings edit; Worker-portable by construction
  (no child processes anywhere in the Herald path).
- Feature velocity: most changes touch prompt/tool rows, not plumbing.

**Negative / accepted risks**

- TanStack AI is 0.x — pinned exact versions, `chat()` imported in exactly one
  service; upgrades are deliberate acts.
- The catalog becomes load-bearing: prompt quality now depends on curated
  Lexa Agents/Skills rows (size discipline required).
- Two tiers must be labeled distinctly in UI — users will expect
  Blacksmith-grade results from Herald runs otherwise.
- API keys held server-side plaintext (accepted for self-hosted threat model).
- Table renames fail at runtime, not compile time — gated by atomic migration
  plus mandatory repo/service test suites.

## Compliance notes

- Emission invariant (#12) preserved: Herald task completion/failure flows
  through the same `ForgeService` lifecycle; chat emits no activity rows (not a
  document mutation).
- Lexa→GitHub sync remains route-orchestrated only (#1); Herald tools are reads.
- REST boundary stays TipTap JSON (#7); markdown conversion only via
  `shared/markdown.ts`.
