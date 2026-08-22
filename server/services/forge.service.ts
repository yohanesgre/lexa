import { Effect } from "effect";
import { ForgeRepo } from "../repos/forge.repo";
import { ForgeSessionRepo } from "../repos/forge-session.repo";
import { SourceRepo } from "../repos/source.repo";
import { TaskRepo } from "../repos/task.repo";
import { WikiRepo } from "../repos/wiki.repo";
import { ProjectRepo } from "../repos/project.repo";
import { SourceService } from "./source.service";
import { ActivityService } from "./activity.service";
import { DbError, RowNotFound, ConstraintViolation, Sqlite, withTx } from "../db/database";
import { ProjectNotFound, TaskNotFound, WikiPageNotFound, ForgeTaskNotFound, NoRuntimeOnline, RuntimeNotFound, AgentNotFound, SkillNotFound, ForgeBuiltinDelete, ForgeEntityInUse, ForgeSessionActive } from "../api/errors";
import { docToMarkdown } from "../../shared/markdown";
import * as msg from "../activity-messages";
import { rowToForgeSession, RuntimeWithTeam } from "../../shared/db";
import type { ForgeTask, ForgeTaskLog, DocumentSource, TipTapDoc, LexaAgent, LexaSkill, ForgeSession, ActivityType, ForgeProvider } from "../../shared/types";

// Builtin seed defaults — mirrors migrations/0001_init.sql (fresh installs) and
// migrations/0004_forge_pm_skills.sql (existing DBs).
// Reset to default restores these exact values (and, for Lexa, the full
// builtin skill set). Keep the two in sync when editing either.
const DEFAULT_AGENT: { id: string; instructions: string; skillIds: string[] } = {
  id: "lexa",
  instructions:
    "You are Forge, Lexa's project management assistant. You help teams run their projects: you write task descriptions, requirements, and wiki pages, and you sharpen the team's documents — spotting missing details, unclear scope, and weak acceptance criteria. You may read files in your working directory (the project workspace) to ground your writing in the actual repo and docs. You do not write files, run commands, or act on any system — your whole output is the text you write. Match the document's existing voice and structure. If the linked sources contradict the document, prefer the sources.",
  skillIds: ["requirements", "deliverables", "review", "definition-of-done", "status", "polish"],
};

const DEFAULT_SKILLS: Record<string, string> = {
  requirements:
    "Write only the task's requirements — what must hold when it's done. One concrete, verifiable condition per checkbox item (- [ ]). No design proposals or background. Output only the checklist.",
  deliverables:
    "Split the task into a checklist of deliverables — concrete, actionable outputs. Each must be independently completable. Note dependencies. Output only the checklist.",
  review:
    "Review the task like a project manager: fix missing details, unclear scope, weak requirements, and risks. Output the improved full task — not a separate report.",
  "definition-of-done":
    "Write a Definition of Done checklist (- [ ]): conditions that must hold before the task counts as complete. Each item concrete and verifiable. Output only the checklist.",
  status:
    "Write a status update: what's done, what's blocked (and why), what's next. Be honest; flag risks early. Output only the status update.",
  polish:
    "Polish the selected text: clearer and more concise, keeping the meaning, structure, and level of detail. Output only the polished text.",
};

export class ForgeService extends Effect.Service<ForgeService>()("Lexa/ForgeService", {
  dependencies: [ForgeRepo.Default, ForgeSessionRepo.Default, SourceRepo.Default, SourceService.Default, TaskRepo.Default, WikiRepo.Default, ProjectRepo.Default, ActivityService.Default],
  effect: Effect.gen(function* () {
    const repo = yield* ForgeRepo;
    const sessionRepo = yield* ForgeSessionRepo;
    const sourceRepo = yield* SourceRepo;
    const sourceService = yield* SourceService;
    const taskRepo = yield* TaskRepo;
    const wikiRepo = yield* WikiRepo;
    const projectRepo = yield* ProjectRepo;
    const activityService = yield* ActivityService;
    const db = yield* Sqlite;

    // Forge runs are unattended — the actor is the agent itself. Agent name
    // resolved at write time; falls back to the agent id.
    const agentName = (agentId: string): Effect.Effect<string, never> =>
      repo.findAgentById(agentId).pipe(
        Effect.map((a) => a.name),
        Effect.catchAll(() => Effect.succeed(agentId))
      );

    // Terminal statuses emit a task-activity row (document_type 'task' only)
    // in the SAME transaction as the status write. Message builds with the
    // RESOLVED agent name.
    const emitTerminal = (forgeTask: ForgeTask, type: ActivityType, buildMessage: (agentName: string) => string): Effect.Effect<void, never> =>
      forgeTask.documentType === "task"
        ? Effect.gen(function* () {
            const name = yield* agentName(forgeTask.agentId);
            yield* activityService.append(forgeTask.documentId, { kind: "agent", label: name }, type, buildMessage(name));
          }).pipe(
            Effect.catchAll(() => Effect.void) // a timeline row must never fail the daemon round-trip
          )
        : Effect.void;

    const loadDocumentContext = (
      projectId: string,
      documentType: "task" | "wiki",
      documentId: string
    ): Effect.Effect<string, TaskNotFound | WikiPageNotFound | DbError | RowNotFound> =>
      Effect.gen(function* () {
        if (documentType === "task") {
          const task = yield* taskRepo.findById(documentId).pipe(
            Effect.catchTag("RowNotFound", () => new TaskNotFound({ id: documentId }))
          );
          // Context is Markdown so the agent sees the document's structure
          // (headings, lists, formatting) and mirrors it in its output.
          const desc = docToMarkdown(task.description as TipTapDoc);
          return `Task: ${task.key} — ${task.title}\n${desc ? `Description:\n${desc}` : ""}`.trim();
        }
        const page = yield* wikiRepo.findBySlug(projectId, documentId).pipe(
          Effect.catchTag("RowNotFound", () => new WikiPageNotFound({ id: documentId }))
        );
        return `Wiki page: ${page.title}\n${docToMarkdown(page.content as TipTapDoc)}`.trim();
      });

    const loadSourcesContent = (
      projectId: string,
      documentType: "task" | "wiki",
      documentId: string
    ): Effect.Effect<string, DbError | RowNotFound | WikiPageNotFound | import("../api/errors").SourceFetchError | import("../api/errors").SourceUnreachable> =>
      Effect.gen(function* () {
        const sources = yield* sourceRepo.findByDocument(projectId, documentType, documentId);
        if (sources.length === 0) return "";
        const parts: string[] = [];
        for (const s of sources) {
          const content = yield* sourceService.resolveContent(projectId, s);
          parts.push(`[Source: ${s.title} (${s.kind})]\n${content.slice(0, 6000)}`);
        }
        return parts.join("\n\n");
      });

    // Forge is a text-only project-management assistant: the agent's role and
    // rules travel as FILES (AGENTS.md + .agents/<skill>/SKILL.md written into
    // the run dir at claim time, read natively by AGENTS.md-capable CLIs like
    // opencode). The agent may read workspace files for grounding; the prompt
    // carries the per-task context plus the hard output contract — anything
    // besides the requested text (status lines, "I found...", MCP chatter,
    // fences) lands verbatim in the document.
    const MARKDOWN_STYLE = [
      "Section headings: use ## and ### — never H1 (the document already has its own title).",
      "Keep paragraphs short and scannable — one idea per paragraph, no walls of text.",
      "Use bullet lists for parallel points, numbered lists for ordered steps.",
      "Use task lists (- [ ] / - [x]) for checklists and acceptance criteria.",
      "Bold key terms (**term**) and wrap technical names in code spans (`TilemapChunkLoader`, `src/core/`, `bun run build`).",
      "Put code samples in fenced blocks with a language tag: ```ts, ```sql, ```bash, ```json.",
      "Use blockquotes (>) sparingly, for notes or warnings.",
      "Prefer plain words over jargon; keep the team's existing vocabulary.",
    ];

    const buildPrompt = (
      task: ForgeTask,
      agent: LexaAgent,
      skill: LexaSkill,
      docContext: string,
      sourcesContent: string,
      hasRepoContent: boolean
    ): string => {
      const sections: string[] = [`Task: ${skill.name}`];
      // The workspace holds every lexa-agent's rule bundle persistently
      // (.agents/agents/<id>/AGENTS.md); the prompt names the active one so
      // the model reads the right file for this run. The skill file gets the
      // same pointer: opencode's globs exclude hidden dirs and the skill tool
      // is denied in the sandbox, so auto-discovery never surfaces SKILL.md —
      // only an explicit path makes delivery deterministic.
      sections.push("", `Agent: ${agent.name} (id ${agent.id}) — read .agents/agents/${agent.id}/AGENTS.md and follow it exactly.`);
      sections.push("", `Skill: ${skill.name} (id ${skill.id}) — read .agents/skills/${skill.id}/SKILL.md and follow it exactly.`);
      if (task.extraPrompt) {
        sections.push("", `Additional instructions:\n${task.extraPrompt}`);
      }
      if (docContext) sections.push("", `Document context:\n${docContext}`);
      if (sourcesContent) sections.push("", `Linked sources (ground your output in these):\n${sourcesContent}`);
      if (hasRepoContent) {
        sections.push("", "Linked GitHub repo content is in the repo-content/ directory of your working directory (see repo-content/MANIFEST.md) — read it to ground your work in the actual code.");
      }
      if (task.selection) sections.push("", `Selected text:\n"""\n${task.selection}\n"""`);
      sections.push(
        "",
        "Your working directory contains AGENTS.md (project rules) and .agents/ (your rules and skills) — follow them.",
        "",
        "Output rules:",
        "- Output ONLY the requested text. Nothing else.",
        "- Preserve the document's existing structure and inline formatting; mirror the selection's style exactly.",
        "- Format as clean, well-structured Markdown. Your output becomes the whole document (converted to rich text), so make it beautiful:",
        ...MARKDOWN_STYLE.map((line) => `  - ${line}`),
        "- No narration, no explanations, no status updates, no 'Here is...'. Never wrap the whole output in a markdown fence — a top-level code fence would land verbatim in the document.",
        "- If the linked sources contradict the document, prefer the sources."
      );
      return sections.join("\n");
    };

    const resolveRulesImpl = (
      task: ForgeTask
    ): Effect.Effect<{ agent: LexaAgent; skill: LexaSkill }, AgentNotFound | SkillNotFound | DbError> =>
      Effect.gen(function* () {
        const agent = yield* repo.findAgentById(task.agentId).pipe(
          Effect.catchTag("RowNotFound", () => new AgentNotFound({ id: task.agentId }))
        );
        const skill = yield* repo.findSkillById(task.skillId).pipe(
          Effect.catchTag("RowNotFound", () => new SkillNotFound({ id: task.skillId }))
        );
        return { agent, skill };
      });

    return {
      // ── Agents ──
      listAgents: (): Effect.Effect<LexaAgent[], DbError> => repo.listAgents(),

      createAgent: (input: { name: string; description: string; instructions: string }): Effect.Effect<LexaAgent, ConstraintViolation | DbError> =>
        repo.createAgent({ ...input, id: crypto.randomUUID() }),

      updateAgent: (id: string, patch: { name?: string; description?: string; instructions?: string }): Effect.Effect<LexaAgent, AgentNotFound | ConstraintViolation | DbError> =>
        repo.updateAgent(id, patch).pipe(Effect.catchTag("RowNotFound", () => new AgentNotFound({ id }))),

      deleteAgent: (id: string): Effect.Effect<void, AgentNotFound | ForgeBuiltinDelete | ForgeEntityInUse | ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          const agent = yield* repo.findAgentById(id).pipe(Effect.catchTag("RowNotFound", () => new AgentNotFound({ id })));
          if (agent.isBuiltin) {
            return yield* new ForgeBuiltinDelete({ kind: "agent", name: agent.name });
          }
          const count = yield* repo.countTasksByAgent(id);
          if (count > 0) {
            return yield* new ForgeEntityInUse({ kind: "agent", name: agent.name, count });
          }
          yield* repo.deleteAgent(id).pipe(
            Effect.catchTag("RowNotFound", () => new AgentNotFound({ id }))
          );
        }),

      replaceAgentSkills: (agentId: string, skillIds: string[]): Effect.Effect<LexaAgent, AgentNotFound | SkillNotFound | ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          yield* repo.findAgentById(agentId).pipe(Effect.catchTag("RowNotFound", () => new AgentNotFound({ id: agentId })));
          const skills = yield* repo.listSkills();
          const known = new Set(skills.map((s) => s.id));
          for (const skillId of skillIds) {
            if (!known.has(skillId)) {
              return yield* new SkillNotFound({ id: skillId });
            }
          }
          yield* repo.replaceAgentSkills(agentId, skillIds);
          return yield* repo.findAgentById(agentId).pipe(Effect.catchTag("RowNotFound", () => new AgentNotFound({ id: agentId })));
        }),

      // Builtin-only: restore the seeded instructions + the full builtin skill set.
      resetAgentToDefault: (id: string): Effect.Effect<LexaAgent, AgentNotFound | ForgeBuiltinDelete | ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          const agent = yield* repo.findAgentById(id).pipe(Effect.catchTag("RowNotFound", () => new AgentNotFound({ id })));
          if (!agent.isBuiltin || agent.id !== DEFAULT_AGENT.id) {
            return yield* new ForgeBuiltinDelete({ kind: "agent", name: agent.name });
          }
          return yield* withTx(
            db,
            Effect.gen(function* () {
              yield* repo.updateAgent(id, { instructions: DEFAULT_AGENT.instructions }).pipe(
                Effect.catchTag("RowNotFound", () => new AgentNotFound({ id }))
              );
              yield* repo.replaceAgentSkills(id, DEFAULT_AGENT.skillIds);
              return yield* repo.findAgentById(id).pipe(Effect.catchTag("RowNotFound", () => new AgentNotFound({ id })));
            })
          );
        }),
      // ── Skills ──
      listSkills: (): Effect.Effect<LexaSkill[], DbError> => repo.listSkills(),

      createSkill: (input: { name: string; description: string; instructions: string }): Effect.Effect<LexaSkill, ConstraintViolation | DbError> =>
        repo.createSkill({ ...input, id: crypto.randomUUID() }),

      updateSkill: (id: string, patch: { name?: string; description?: string; instructions?: string }): Effect.Effect<LexaSkill, SkillNotFound | ConstraintViolation | DbError> =>
        repo.updateSkill(id, patch).pipe(Effect.catchTag("RowNotFound", () => new SkillNotFound({ id }))),

      deleteSkill: (id: string): Effect.Effect<void, SkillNotFound | ForgeBuiltinDelete | ForgeEntityInUse | ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          const skill = yield* repo.findSkillById(id).pipe(Effect.catchTag("RowNotFound", () => new SkillNotFound({ id })));
          if (skill.isBuiltin) {
            return yield* new ForgeBuiltinDelete({ kind: "skill", name: skill.name });
          }
          const count = yield* repo.countTasksBySkill(id);
          if (count > 0) {
            return yield* new ForgeEntityInUse({ kind: "skill", name: skill.name, count });
          }
          yield* repo.deleteSkill(id).pipe(
            Effect.catchTag("RowNotFound", () => new SkillNotFound({ id }))
          );
        }),

      resetSkillToDefault: (id: string): Effect.Effect<LexaSkill, SkillNotFound | ForgeBuiltinDelete | ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          const skill = yield* repo.findSkillById(id).pipe(Effect.catchTag("RowNotFound", () => new SkillNotFound({ id })));
          const instructions = DEFAULT_SKILLS[skill.id];
          if (!skill.isBuiltin || instructions === undefined) {
            return yield* new ForgeBuiltinDelete({ kind: "skill", name: skill.name });
          }
          return yield* repo.updateSkill(id, { instructions }).pipe(
            Effect.catchTag("RowNotFound", () => new SkillNotFound({ id }))
          );
        }),

      // ── Tasks ──
      create: (input: {
        projectId: string;
        documentType: "task" | "wiki";
        documentId: string;
        agentId: string;
        skillId: string;
        extraPrompt?: string;
        selection: string;
        runtimeId?: string;   // preferred runtime
      }): Effect.Effect<ForgeTask, ProjectNotFound | TaskNotFound | WikiPageNotFound | AgentNotFound | SkillNotFound | NoRuntimeOnline | DbError | RowNotFound | ConstraintViolation> =>
        Effect.gen(function* () {
          yield* projectRepo.findById(input.projectId).pipe(
            Effect.catchTag("RowNotFound", () => new ProjectNotFound({ identifier: input.projectId }))
          );
          // Require at least one online runtime before enqueueing. Forge runs
          // on the daemon's agent CLI directly (the claim carries all context),
          // so no Lexa MCP connection is needed on the runtime anymore.
          const runtimes = yield* repo.listRuntimes();
          if (!runtimes.some((r) => r.status === "online")) {
            return yield* new NoRuntimeOnline();
          }
          if (input.runtimeId) {
            const preferred = runtimes.find((r) => r.id === input.runtimeId);
            if (!preferred || preferred.status !== "online") {
              return yield* new NoRuntimeOnline();
            }
          }
          yield* repo.findAgentById(input.agentId).pipe(
            Effect.catchTag("RowNotFound", () => new AgentNotFound({ id: input.agentId }))
          );
          yield* repo.findSkillById(input.skillId).pipe(
            Effect.catchTag("RowNotFound", () => new SkillNotFound({ id: input.skillId }))
          );
          const docContext = yield* loadDocumentContext(input.projectId, input.documentType, input.documentId);
          return yield* repo.createTask({
            id: crypto.randomUUID(),
            projectId: input.projectId,
            documentType: input.documentType,
            documentId: input.documentId,
            agentId: input.agentId,
            skillId: input.skillId,
            extraPrompt: input.extraPrompt ?? "",
            selection: input.selection,
            docContext,
            runtimeId: input.runtimeId,
          });
        }),

      getById: (id: string): Effect.Effect<ForgeTask, ForgeTaskNotFound | DbError> =>
        repo.findTaskById(id).pipe(Effect.catchTag("RowNotFound", () => new ForgeTaskNotFound({ id }))),

      claimNext: (runtimeId: string): Effect.Effect<ForgeTask | null, ConstraintViolation | DbError | RowNotFound | RuntimeNotFound> =>
        Effect.gen(function* () {
          // Team scoping: the runtime's team_id gates what it may claim
          // (NULL = global). The runtime must exist to resolve its scope.
          const runtime = yield* repo.findRuntimeById(runtimeId).pipe(
            Effect.catchTag("RowNotFound", () => new RuntimeNotFound({ id: runtimeId }))
          );
          return yield* repo.claimNextTask(runtimeId, runtime.teamId);
        }),

      // Warm-session verdict for a claimed task: continue the mapped session
      // ONLY when the mapping exists AND its agent/skill match the task's —
      // an agent/skill change resets continuity (null → daemon mints fresh).
      resolveSessionForTask: (task: ForgeTask, runtimeId: string): Effect.Effect<string | null, DbError> =>
        sessionRepo.get(task.documentType, task.documentId, runtimeId).pipe(
          Effect.map((row) => (row && row.agent_id === task.agentId && row.skill_id === task.skillId ? row.runtime_session_id : null))
        ),

      // Pre-spawn mapping write (spec §8 step 3): the row exists before the
      // run starts; upsert also rewrites it on stale-session retry.
      forgeSessionUpsert: (input: {
        documentType: "task" | "wiki";
        documentId: string;
        runtimeId: string;
        runtimeSessionId: string;
        provider: ForgeProvider;
        agentId: string;
        skillId: string;
      }): Effect.Effect<void, ConstraintViolation | DbError> =>
        sessionRepo.upsert(input),

      forgeSessionList: (documentType: "task" | "wiki", documentId: string): Effect.Effect<ForgeSession[], DbError> =>
        sessionRepo.listForDocument(documentType, documentId).pipe(
          Effect.map((rows) => rows.map(rowToForgeSession))
        ),

      forgeSessionGet: (documentType: "task" | "wiki", documentId: string, runtimeId: string): Effect.Effect<ForgeSession | null, DbError> =>
        sessionRepo.get(documentType, documentId, runtimeId).pipe(
          Effect.map((row) => (row ? rowToForgeSession(row) : null))
        ),

      // Daemon-side drop on cancel/timeout — always allowed (never 409):
      // the in-flight run is gone, nothing will re-write the row.
      forgeSessionRemove: (documentType: "task" | "wiki", documentId: string, runtimeId: string): Effect.Effect<void, ConstraintViolation | DbError> =>
        sessionRepo.remove(documentType, documentId, runtimeId),

      // User-facing reset: 409 while a task on this document+runtime is in
      // flight — otherwise the run's completion would re-write the row the
      // user just deleted and silently undo the reset.
      forgeSessionReset: (documentType: "task" | "wiki", documentId: string, runtimeId: string): Effect.Effect<void, ForgeSessionActive | ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          const active = yield* sessionRepo.hasActiveTask(documentType, documentId, runtimeId);
          if (active) return yield* new ForgeSessionActive();
          yield* sessionRepo.remove(documentType, documentId, runtimeId);
        }),

      complete: (id: string, result: string): Effect.Effect<ForgeTask, ForgeTaskNotFound | ConstraintViolation | DbError> =>
        withTx(db, Effect.gen(function* () {
          const updated = yield* repo.updateTaskStatus(id, "completed", result, null).pipe(
            Effect.catchTag("RowNotFound", () => new ForgeTaskNotFound({ id }))
          );
          yield* emitTerminal(updated, "forge_completed", (name) => msg.forgeCompleted(name));
          return updated;
        })),

      fail: (id: string, error: string): Effect.Effect<ForgeTask, ForgeTaskNotFound | ConstraintViolation | DbError> =>
        withTx(db, Effect.gen(function* () {
          const updated = yield* repo.updateTaskStatus(id, "failed", null, error).pipe(
            Effect.catchTag("RowNotFound", () => new ForgeTaskNotFound({ id }))
          );
          yield* emitTerminal(updated, "forge_failed", () => msg.forgeFailed());
          return updated;
        })),

      cancel: (id: string): Effect.Effect<ForgeTask, ForgeTaskNotFound | ConstraintViolation | DbError> =>
        withTx(db, Effect.gen(function* () {
          const updated = yield* repo.updateTaskStatus(id, "cancelled", null, null).pipe(
            Effect.catchTag("RowNotFound", () => new ForgeTaskNotFound({ id }))
          );
          yield* emitTerminal(updated, "forge_cancelled", () => msg.forgeCancelled());
          return updated;
        })),

      // Resolve the task's agent + skill rows (claim-time rule delivery —
      // the daemon writes these as files, never via the prompt).
      resolveRules: (task: ForgeTask): Effect.Effect<{ agent: LexaAgent; skill: LexaSkill }, AgentNotFound | SkillNotFound | DbError> =>
        resolveRulesImpl(task),

      // Build the full prompt (with resolved sources) for the daemon.
      // hasRepoContent: the claim handler points the agent at repo-content/
      // only when linked-repo files actually shipped with the claim.
      buildPromptForTask: (task: ForgeTask, hasRepoContent = false): Effect.Effect<string, AgentNotFound | SkillNotFound | DbError | RowNotFound | WikiPageNotFound | import("../api/errors").SourceFetchError | import("../api/errors").SourceUnreachable> =>
        Effect.gen(function* () {
          const { agent, skill } = yield* resolveRulesImpl(task);
          const sourcesContent = yield* loadSourcesContent(task.projectId, task.documentType, task.documentId);
          return buildPrompt(task, agent, skill, task.docContext, sourcesContent, hasRepoContent);
        }),

      listForDocument: (projectId: string, documentType: "task" | "wiki", documentId: string): Effect.Effect<ForgeTask[], DbError> =>
        repo.listTasksForDocument(projectId, documentType, documentId),

      // Recent tasks across all projects (navbar status bar).
      listRecent: (limit = 10): Effect.Effect<Array<ForgeTask & { projectName: string }>, DbError> =>
        repo.listRecent(limit).pipe(
          Effect.map((rows) => rows.map((r) => ({ ...r, projectName: r.project_name })))
        ),

      // Full task history for the Forge control panel: optional project/status/
      // skill/type filters, keyset-paginated (limit + cursor → next cursor).
      // summary carries per-status totals (global — not filter-scoped).
      listHistory: (
        filters: { projectId?: string; status?: ForgeTask["status"]; skillId?: string; documentType?: "task" | "wiki" },
        limit = 50,
        cursor?: string
      ): Effect.Effect<{ tasks: Array<ForgeTask & { projectName: string }>; nextCursor: string | null; summary: Record<ForgeTask["status"], number> }, DbError> =>
        Effect.gen(function* () {
          const [page, summary] = yield* Effect.all([repo.listHistory(filters, limit, cursor), repo.countByStatus()]);
          const last = page.tasks[page.tasks.length - 1];
          const nextCursor = page.hasMore && last ? `${last.createdAt}:${last.id}` : null;
          return {
            tasks: page.tasks.map((r) => ({ ...r, projectName: r.project_name })),
            nextCursor,
            summary,
          };
        }),

      // Live activity feed for a task — the daemon appends lines, the UI
      // polls while the task is running. The message is bounded so a chatty
      // agent can't grow rows without limit (daemon truncates to 500; this
      // is the server-side safety net). stream/level are classified ONCE by
      // the daemon (shared/forge-log.ts) and stored — the UI renders them.
      appendLog: (
        taskId: string,
        message: string,
        stream: "out" | "err" = "out",
        level: "info" | "warn" | "error" = "info"
      ): Effect.Effect<ForgeTaskLog, ForgeTaskNotFound | ConstraintViolation | DbError | RowNotFound> =>
        Effect.gen(function* () {
          yield* repo.findTaskById(taskId).pipe(
            Effect.catchTag("RowNotFound", () => new ForgeTaskNotFound({ id: taskId }))
          );
          const bounded = message.slice(0, 2000);
          return yield* repo.appendLog(crypto.randomUUID(), taskId, bounded, stream, level);
        }),

      listLogs: (taskId: string): Effect.Effect<ForgeTaskLog[], DbError> =>
        repo.listLogs(taskId),

      // Runtimes
      registerRuntime: (input: { id?: string; name: string; provider: "opencode" | "hermes" | "command-code"; machineId: string; agent: string; model: string; hostname: string; teamId?: string | null }): Effect.Effect<RuntimeWithTeam, ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          const id = input.id ?? crypto.randomUUID();
          return yield* repo.registerRuntime({ ...input, id, teamId: input.teamId ?? null });
        }),

      // Server-authoritative config: edits apply on the daemon's next claim/spawn.
      updateRuntime: (id: string, patch: { name?: string; provider?: "opencode" | "hermes" | "command-code"; agent?: string; model?: string; printLogs?: boolean; logLevel?: string; extraArgs?: string[] }): Effect.Effect<RuntimeWithTeam, RuntimeNotFound | ConstraintViolation | DbError> =>
        repo.updateRuntime(id, patch).pipe(
          Effect.catchTag("RowNotFound", () => new RuntimeNotFound({ id }))
        ),

      getRuntimeConfig: (id: string): Effect.Effect<RuntimeWithTeam, RuntimeNotFound | DbError> =>
        repo.findRuntimeById(id).pipe(
          Effect.catchTag("RowNotFound", () => new RuntimeNotFound({ id }))
        ),

      removeRuntime: (id: string): Effect.Effect<void, RuntimeNotFound | ConstraintViolation | DbError> =>
        repo.deleteRuntime(id).pipe(
          Effect.catchTag("RowNotFound", () => new RuntimeNotFound({ id }))
        ),

      // Remove events are provider-scoped and a machine hosts at most one
      // runtime per agent CLI — delete the whole (machine, provider) pair so
      // host state stays consistent with the queued event.
      removeRuntimePair: (machineId: string, provider: "opencode" | "hermes" | "command-code"): Effect.Effect<void, ConstraintViolation | DbError> =>
        repo.deleteRuntimePair(machineId, provider),

      reportDaemonErrors: (errors: Array<{ runtimeId: string; error: string }>): Effect.Effect<void, ConstraintViolation | DbError> =>
        Effect.forEach(errors, (entry) => repo.setRuntimeLastError(entry.runtimeId, entry.error.slice(0, 500))).pipe(
          Effect.map(() => undefined)
        ),

      clearRuntimeLastError: (id: string): Effect.Effect<void, ConstraintViolation | DbError> =>
        repo.clearRuntimeLastError(id),

      sweepStuckTasks: (): Effect.Effect<number, ConstraintViolation | DbError> =>
        repo.sweepStuckTasks(),

      // Stale-run auto-removal threshold: a `running` task older than this
      // whose runtime is offline/gone is hard-deleted (task + log). A live
      // runtime is never touched. Override with FORGE_STALE_RUN_MIN.
      sweepStalledTasks: (): Effect.Effect<number, ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          const staleMin = (() => {
            const v = Number(process.env.FORGE_STALE_RUN_MIN);
            return Number.isFinite(v) && v > 0 ? v : 30;
          })();
          // Delete BEFORE re-queue: re-queuing first would move the stale
          // run out of 'running' and shield it from the removal check.
          const removed = yield* repo.deleteStaleRuns(staleMin);
          const requeued = yield* repo.sweepStuckTasks();
          return requeued + removed;
        }),

      heartbeat: (id: string): Effect.Effect<void, ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          yield* repo.updateRuntimeHeartbeat(id);
        }),

      syncCatalogs: (machineId: string, catalogs: Array<{
        runtimeId: string;
        agentCli: "opencode" | "hermes" | "command-code";
        models: { id: string; provider: string; name: string }[];
        agents: { id: string; name: string }[];
      }>): Effect.Effect<void, ConstraintViolation | DbError> =>
        Effect.forEach(catalogs, (catalog) => repo.updateRuntimeCatalogs({
          id: catalog.runtimeId,
          machineId,
          agentCli: catalog.agentCli,
          models: catalog.models,
          agents: catalog.agents,
        })).pipe(Effect.map(() => undefined)),

      listRuntimes: (): Effect.Effect<RuntimeWithTeam[], ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          yield* repo.markRuntimesOffline();
          return yield* repo.listRuntimes();
        }),
    };
  }),
}) {}
