import { Effect } from "effect";
import { ForgeRepo } from "../repos/forge.repo";
import { SourceRepo } from "../repos/source.repo";
import { TaskRepo } from "../repos/task.repo";
import { WikiRepo } from "../repos/wiki.repo";
import { ProjectRepo } from "../repos/project.repo";
import { SourceService } from "./source.service";
import { DbError, RowNotFound, ConstraintViolation } from "../db/database";
import { ProjectNotFound, TaskNotFound, WikiPageNotFound, ForgeTaskNotFound, NoRuntimeOnline, RuntimeNotFound, AgentNotFound, SkillNotFound, ForgeBuiltinDelete, ForgeEntityInUse } from "../api/errors";
import { docToMarkdown } from "../../shared/markdown";
import type { ForgeTask, ForgeTaskLog, DocumentSource, TipTapDoc, ForgeAgent, ForgeSkill } from "../../shared/types";

// Builtin seed defaults — mirrors migrations/0027_forge_agents_skills.sql.
// Reset to default restores these exact values (and, for Lexa, the full
// builtin skill set). Keep the two in sync when editing either.
const DEFAULT_AGENT: { id: string; instructions: string; skillIds: string[] } = {
  id: "lexa",
  instructions:
    "You are Forge, a writing assistant inside Lexa. You help a game-dev team write task descriptions and wiki pages. You are a text editor, not an agent: you do not call tools, you do not read files, and you do not act on any system. Your whole output is the text you write.",
  skillIds: ["continue", "rewrite", "summarize", "expand", "grammar"],
};

const DEFAULT_SKILLS: Record<string, string> = {
  continue:
    "Continue the text below naturally, matching its style, tone, and structure. Output only the continuation, no preamble.",
  rewrite:
    "Rewrite the selected text to be clearer and more concise. Keep the meaning. Keep the same structure and level of detail — tighten the prose, don't restructure arbitrarily. Output only the rewritten text.",
  summarize:
    "Summarize the selected text. Lead with a 1–2 sentence overview, then 3–6 bullets of the key points. Keep it tight. Output only the summary.",
  expand:
    "Expand the selected text into more detail, keeping the same voice. Break it into labeled sections with subheadings and add concrete examples or specifics where they help. Output only the expanded text.",
  grammar:
    "Fix grammar, spelling, and punctuation in the selected text. Do not change meaning, style, or structure — preserve the exact formatting. Output only the corrected text.",
};

export class ForgeService extends Effect.Service<ForgeService>()("Lexa/ForgeService", {
  dependencies: [ForgeRepo.Default, SourceRepo.Default, SourceService.Default, TaskRepo.Default, WikiRepo.Default, ProjectRepo.Default],
  effect: Effect.gen(function* () {
    const repo = yield* ForgeRepo;
    const sourceRepo = yield* SourceRepo;
    const sourceService = yield* SourceService;
    const taskRepo = yield* TaskRepo;
    const wikiRepo = yield* WikiRepo;
    const projectRepo = yield* ProjectRepo;

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
          return `Task: ${task.title}\n${desc ? `Description:\n${desc}` : ""}`.trim();
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

    // Forge is a pure text-generation assistant: the agent's role and rules
    // travel as FILES (AGENTS.md + .agents/<skill>/SKILL.md written into the
    // run dir at claim time, read natively by AGENTS.md-capable CLIs like
    // opencode). The prompt carries the per-task context plus the hard
    // output contract — anything besides the requested text (status lines,
    // "I found...", MCP chatter, fences) lands verbatim in the document.
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
      skill: ForgeSkill,
      docContext: string,
      sourcesContent: string
    ): string => {
      const sections: string[] = [`Task: ${skill.name}`];
      if (task.extraPrompt) {
        sections.push("", `Additional instructions:\n${task.extraPrompt}`);
      }
      if (docContext) sections.push("", `Document context:\n${docContext}`);
      if (sourcesContent) sections.push("", `Linked sources (ground your output in these):\n${sourcesContent}`);
      if (task.selection) sections.push("", `Selected text:\n"""\n${task.selection}\n"""`);
      sections.push(
        "",
        "Your working directory contains AGENTS.md (your role and rules) and .agents/ (your skills) — follow them.",
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
    ): Effect.Effect<{ agent: ForgeAgent; skill: ForgeSkill }, AgentNotFound | SkillNotFound | DbError> =>
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
      listAgents: (): Effect.Effect<ForgeAgent[], DbError> => repo.listAgents(),

      createAgent: (input: { name: string; description: string; instructions: string }): Effect.Effect<ForgeAgent, ConstraintViolation | DbError> =>
        repo.createAgent({ ...input, id: crypto.randomUUID() }),

      updateAgent: (id: string, patch: { name?: string; description?: string; instructions?: string }): Effect.Effect<ForgeAgent, AgentNotFound | ConstraintViolation | DbError> =>
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

      replaceAgentSkills: (agentId: string, skillIds: string[]): Effect.Effect<ForgeAgent, AgentNotFound | SkillNotFound | ConstraintViolation | DbError> =>
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
      resetAgentToDefault: (id: string): Effect.Effect<ForgeAgent, AgentNotFound | ForgeBuiltinDelete | ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          const agent = yield* repo.findAgentById(id).pipe(Effect.catchTag("RowNotFound", () => new AgentNotFound({ id })));
          if (!agent.isBuiltin || agent.id !== DEFAULT_AGENT.id) {
            return yield* new ForgeBuiltinDelete({ kind: "agent", name: agent.name });
          }
          yield* repo.updateAgent(id, { instructions: DEFAULT_AGENT.instructions }).pipe(
            Effect.catchTag("RowNotFound", () => new AgentNotFound({ id }))
          );
          yield* repo.replaceAgentSkills(id, DEFAULT_AGENT.skillIds);
          return yield* repo.findAgentById(id).pipe(Effect.catchTag("RowNotFound", () => new AgentNotFound({ id })));
        }),
      // ── Skills ──
      listSkills: (): Effect.Effect<ForgeSkill[], DbError> => repo.listSkills(),

      createSkill: (input: { name: string; description: string; instructions: string }): Effect.Effect<ForgeSkill, ConstraintViolation | DbError> =>
        repo.createSkill({ ...input, id: crypto.randomUUID() }),

      updateSkill: (id: string, patch: { name?: string; description?: string; instructions?: string }): Effect.Effect<ForgeSkill, SkillNotFound | ConstraintViolation | DbError> =>
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

      resetSkillToDefault: (id: string): Effect.Effect<ForgeSkill, SkillNotFound | ForgeBuiltinDelete | ConstraintViolation | DbError> =>
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

      claimNext: (runtimeId: string): Effect.Effect<ForgeTask | null, ConstraintViolation | DbError | RowNotFound> =>
        repo.claimNextTask(runtimeId),

      complete: (id: string, result: string): Effect.Effect<ForgeTask, ForgeTaskNotFound | ConstraintViolation | DbError> =>
        repo.updateTaskStatus(id, "completed", result, null).pipe(
          Effect.catchTag("RowNotFound", () => new ForgeTaskNotFound({ id }))
        ),

      fail: (id: string, error: string): Effect.Effect<ForgeTask, ForgeTaskNotFound | ConstraintViolation | DbError> =>
        repo.updateTaskStatus(id, "failed", null, error).pipe(
          Effect.catchTag("RowNotFound", () => new ForgeTaskNotFound({ id }))
        ),

      cancel: (id: string): Effect.Effect<ForgeTask, ForgeTaskNotFound | ConstraintViolation | DbError> =>
        repo.updateTaskStatus(id, "cancelled", null, null).pipe(
          Effect.catchTag("RowNotFound", () => new ForgeTaskNotFound({ id }))
        ),

      // Resolve the task's agent + skill rows (claim-time rule delivery —
      // the daemon writes these as files, never via the prompt).
      resolveRules: (task: ForgeTask): Effect.Effect<{ agent: ForgeAgent; skill: ForgeSkill }, AgentNotFound | SkillNotFound | DbError> =>
        resolveRulesImpl(task),

      // Build the full prompt (with resolved sources) for the daemon.
      buildPromptForTask: (task: ForgeTask): Effect.Effect<string, AgentNotFound | SkillNotFound | DbError | RowNotFound | WikiPageNotFound | import("../api/errors").SourceFetchError | import("../api/errors").SourceUnreachable> =>
        Effect.gen(function* () {
          const { skill } = yield* resolveRulesImpl(task);
          const sourcesContent = yield* loadSourcesContent(task.projectId, task.documentType, task.documentId);
          return buildPrompt(task, skill, task.docContext, sourcesContent);
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
      // is the server-side safety net).
      appendLog: (taskId: string, message: string): Effect.Effect<ForgeTaskLog, ForgeTaskNotFound | ConstraintViolation | DbError | RowNotFound> =>
        Effect.gen(function* () {
          yield* repo.findTaskById(taskId).pipe(
            Effect.catchTag("RowNotFound", () => new ForgeTaskNotFound({ id: taskId }))
          );
          const bounded = message.slice(0, 2000);
          return yield* repo.appendLog(crypto.randomUUID(), taskId, bounded);
        }),

      listLogs: (taskId: string): Effect.Effect<ForgeTaskLog[], DbError> =>
        repo.listLogs(taskId),

      // Runtimes
      registerRuntime: (input: { id?: string; name: string; provider: "opencode" | "hermes" | "command-code"; machineId: string; agent: string; model: string; hostname: string }): Effect.Effect<import("../../shared/types").Runtime, ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          const id = input.id ?? crypto.randomUUID();
          return yield* repo.registerRuntime({ ...input, id });
        }),

      // Server-authoritative config: edits apply on the daemon's next claim/spawn.
      updateRuntime: (id: string, patch: { name?: string; provider?: "opencode" | "hermes" | "command-code"; agent?: string; model?: string; printLogs?: boolean; logLevel?: string; extraArgs?: string[] }): Effect.Effect<import("../../shared/types").Runtime, RuntimeNotFound | ConstraintViolation | DbError> =>
        repo.updateRuntime(id, patch).pipe(
          Effect.catchTag("RowNotFound", () => new RuntimeNotFound({ id }))
        ),

      getRuntimeConfig: (id: string): Effect.Effect<import("../../shared/types").Runtime, RuntimeNotFound | DbError> =>
        repo.findRuntimeById(id).pipe(
          Effect.catchTag("RowNotFound", () => new RuntimeNotFound({ id }))
        ),

      removeRuntime: (id: string): Effect.Effect<void, RuntimeNotFound | ConstraintViolation | DbError> =>
        repo.deleteRuntime(id).pipe(
          Effect.catchTag("RowNotFound", () => new RuntimeNotFound({ id }))
        ),

      heartbeat: (id: string, mcpConnected: boolean): Effect.Effect<void, ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          yield* repo.updateRuntimeHeartbeat(id, mcpConnected);
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

      listRuntimes: (): Effect.Effect<import("../../shared/types").Runtime[], ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          yield* repo.markRuntimesOffline();
          return yield* repo.listRuntimes();
        }),
    };
  }),
}) {}
