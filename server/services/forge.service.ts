import { Effect } from "effect";
import { ForgeRepo } from "../repos/forge.repo";
import { SourceRepo } from "../repos/source.repo";
import { TaskRepo } from "../repos/task.repo";
import { WikiRepo } from "../repos/wiki.repo";
import { ProjectRepo } from "../repos/project.repo";
import { SourceService } from "./source.service";
import { DbError, RowNotFound, ConstraintViolation } from "../db/database";
import { ProjectNotFound, TaskNotFound, WikiPageNotFound, ForgeTaskNotFound, NoRuntimeOnline } from "../api/errors";
import { extractText } from "../../shared/tiptap-text";
import type { ForgeTask, DocumentSource, TipTapDoc } from "../../shared/types";

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
          const desc = extractText(task.description as TipTapDoc);
          return `Task: ${task.title}\n${desc ? `Description:\n${desc}` : ""}`.trim();
        }
        const page = yield* wikiRepo.findBySlug(projectId, documentId).pipe(
          Effect.catchTag("RowNotFound", () => new WikiPageNotFound({ id: documentId }))
        );
        return `Wiki page: ${page.title}\n${extractText(page.content as TipTapDoc)}`.trim();
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

    const ACTION_PROMPTS: Record<string, string> = {
      continue: "Continue the text below naturally, matching its style and tone. Output only the continuation, no preamble.",
      rewrite: "Rewrite the selected text to be clearer and more concise. Keep the meaning. Output only the rewritten text.",
      summarize: "Summarize the selected text in a few sentences. Output only the summary.",
      expand: "Expand the selected text into more detail, keeping the same voice. Output only the expanded text.",
      grammar: "Fix grammar, spelling, and punctuation in the selected text. Do not change meaning or style. Output only the corrected text.",
    };

    const buildPrompt = (
      task: ForgeTask,
      docContext: string,
      sourcesContent: string
    ): string =>
      [
        "You are Forge, the writing assistant inside Lexa. You help a game-dev team write task descriptions and wiki pages.",
        "",
        `Action: ${task.action} — ${ACTION_PROMPTS[task.action] ?? ACTION_PROMPTS.continue}`,
        "",
        docContext ? `Document context:\n${docContext}\n` : "",
        sourcesContent ? `Linked sources (ground your output in these):\n${sourcesContent}\n` : "",
        task.selection ? `Selected text:\n"""\n${task.selection}\n"""\n` : "",
        "",
        "Rules:",
        "- Output only the requested text. No explanations, no markdown fences, no 'Here is...'.",
        "- Stay consistent with the document's existing style.",
        "- If the linked sources contradict the document, prefer the sources and note the conflict in one short line at the end.",
        "",
        "If you need to look up anything in Lexa (other tasks, wiki pages, project data), use the MCP tools available to you. Your result is returned to the editor for the user to accept or reject.",
      ].join("\n");

    return {
      create: (input: {
        projectId: string;
        documentType: "task" | "wiki";
        documentId: string;
        action: string;
        selection: string;
        runtimeId?: string;   // preferred runtime
      }): Effect.Effect<ForgeTask, ProjectNotFound | TaskNotFound | WikiPageNotFound | NoRuntimeOnline | DbError | RowNotFound | ConstraintViolation> =>
        Effect.gen(function* () {
          yield* projectRepo.findById(input.projectId).pipe(
            Effect.catchTag("RowNotFound", () => new ProjectNotFound({ identifier: input.projectId }))
          );
          // Require at least one online runtime before enqueueing.
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
          const docContext = yield* loadDocumentContext(input.projectId, input.documentType, input.documentId);
          return yield* repo.createTask({
            id: crypto.randomUUID(),
            projectId: input.projectId,
            documentType: input.documentType,
            documentId: input.documentId,
            action: (input.action as ForgeTask["action"]) ?? "continue",
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

      // Build the full prompt (with resolved sources) for the daemon.
      buildPromptForTask: (task: ForgeTask): Effect.Effect<string, DbError | RowNotFound | WikiPageNotFound | import("../api/errors").SourceFetchError | import("../api/errors").SourceUnreachable> =>
        Effect.gen(function* () {
          const sourcesContent = yield* loadSourcesContent(task.projectId, task.documentType, task.documentId);
          return buildPrompt(task, task.docContext, sourcesContent);
        }),

      listForDocument: (projectId: string, documentType: "task" | "wiki", documentId: string): Effect.Effect<ForgeTask[], DbError> =>
        repo.listTasksForDocument(projectId, documentType, documentId),

      // Recent tasks across all projects (navbar status bar).
      listRecent: (limit = 10): Effect.Effect<Array<ForgeTask & { projectName: string; documentTitle: string }>, DbError> =>
        repo.listRecent(limit).pipe(
          Effect.map((rows) => rows.map((r) => ({ ...r, projectName: r.project_name, documentTitle: r.document_title })))
        ),

      // Runtimes
      registerRuntime: (input: { name: string; provider: "opencode" | "hermes" | "command-code"; hostname: string }): Effect.Effect<import("../../shared/types").Runtime, ConstraintViolation | DbError> =>
        repo.registerRuntime({ id: crypto.randomUUID(), ...input }),

      heartbeat: (id: string): Effect.Effect<void, ConstraintViolation | DbError> =>
        repo.updateRuntimeHeartbeat(id),

      listRuntimes: (): Effect.Effect<import("../../shared/types").Runtime[], ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          yield* repo.markRuntimesOffline();
          return yield* repo.listRuntimes();
        }),
    };
  }),
}) {}
