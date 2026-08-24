import { Effect } from "effect";
import type { ModelMessage, StreamChunk } from "@tanstack/ai";
import {
  completeText,
  streamChat,
  testConnection as providerTestConnection,
  translateRunError,
  type ProviderConfig,
} from "../herald/provider";
import {
  CHAT_IDENTITY,
  IDENTITY,
  buildSystemPrompts,
  buildUserMessage,
  extractMemoryTerms,
  memoryBlockFromHits,
  type CacheablePrompt,
} from "../herald/prompt";
import { buildHeraldTools, MAX_CHAT_TOOL_ROUNDS, MAX_TOOL_ROUNDS, toolCallDetail, type TaskRef } from "../herald/tools";
import { ForgeRepo } from "../repos/forge.repo";
import { HeraldSettingsRepo, type HeraldSettingsRow } from "../repos/herald-settings.repo";
import { HeraldThreadRepo, type HeraldThread } from "../repos/herald-thread.repo";
import { ProjectMemoryRepo } from "../repos/project-memory.repo";
import { TaskRepo } from "../repos/task.repo";
import { WikiRepo } from "../repos/wiki.repo";
import { ForgeService, BLACKSMITH_AGENT, HERALD_AGENT } from "./forge.service";
import { loadTaskRepoContent } from "./forge-repo-content";
import { Storage } from "../storage/storage";
import { Sqlite, DbError, RowNotFound } from "../db/database";
import {
  AgentNotFound,
  EngineNotSupportedForChat,
  errorCodeMap,
  ForgeTaskNotFound,
  HeraldGenerationFailed,
  HeraldTaskActive,
  HeraldThreadNotFound,
  HeraldToolBudgetExceeded,
  InvalidArgs,
  NoRuntimeOnline,
  ProviderAuthFailed,
  ProviderNotConfigured,
  ProviderUnreachable,
  SkillNotFound,
  TaskNotFound,
  VisionNotConfigured,
  WikiPageNotFound,
} from "../api/errors";
import { GitHubClient } from "../github/client";
import { ProjectReposRepo } from "../repos/project-repos.repo";
import { docToMarkdown } from "../../shared/markdown";
import { extractText } from "../../shared/tiptap-text";
import { parseTaskKey } from "../task-key";
import type { TipTapDoc, Task } from "../../shared/types";
import type { Citation, HeraldChatStreamRequest, StreamFrame } from "../../shared/herald";
import { deriveChatTitle } from "../../shared/herald";
import { buildAnalyzeImageTool, resolveVisionMode, type VisionMode } from "../herald/vision";

export const SUMMARY_THRESHOLD_MESSAGES = 40;
export const SUMMARY_THRESHOLD_BYTES = 64 * 1024;
export const SUMMARY_WINDOW = 8;

export const DOC_IMAGE_CAPS = { maxCount: 5, maxBytesEach: 5 * 1024 * 1024 };
export const CHAT_IMAGE_CAPS = { maxCount: 3, maxTotalBytes: Math.floor(1.5 * 1024 * 1024) };
export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

// @-mention context caps (chat send contract, docs/API.md). Enforced by
// SILENT truncation — never errors.
export const MENTION_CAPS = {
  maxMentions: 5,
  maxPerDocumentChars: 4000,
  maxTotalChars: 20000,
};

// Plain-text tokens in the chat textarea: `@LEX-42`, `@wiki-slug`. A token
// must start with an alphanumeric char; `-`/`_` allowed inside. The
// lookbehind skips email addresses (`a@b.no` yields no token).
export function scanMentionTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?<![A-Za-z0-9])@([A-Za-z0-9][A-Za-z0-9_-]*)/g)) {
    out.push(m[1]);
  }
  return out;
}

export interface ResolvedMention {
  kind: "task" | "wiki";
  id: string;
  label: string;
  text: string;
}

// Bounded ephemeral context block from resolved mentions. Caps applied in
// order: ≤5 mentions, ≤4000 chars of extracted text per document, ≤20000
// chars total — everything beyond a cap is silently dropped.
export function buildMentionContextBlock(resolved: ResolvedMention[]): string {
  if (resolved.length === 0) return "";
  const lines: string[] = ["Referenced by the user just now:"];
  let total = 0;
  let used = 0;
  for (const m of resolved) {
    if (used >= MENTION_CAPS.maxMentions) break;
    const text = m.text.length > MENTION_CAPS.maxPerDocumentChars
      ? `${m.text.slice(0, MENTION_CAPS.maxPerDocumentChars)}…`
      : m.text;
    const line = `- [${m.kind}] ${m.label}\n${text}`;
    if (total + line.length > MENTION_CAPS.maxTotalChars) break;
    lines.push(line);
    total += line.length;
    used += 1;
  }
  return lines.join("\n");
}

// Transcript-persisted image form. Hydrated to a base64 `data` ImagePart at
// call time — self-hosted storage URLs are not reachable by providers.
export interface StoredImageRef {
  type: "image-ref";
  storageKey: string;
  mimeType: string;
}

export function isStoredImageRef(part: unknown): part is StoredImageRef {
  return (
    typeof part === "object" &&
    part !== null &&
    (part as { type?: unknown }).type === "image-ref" &&
    typeof (part as { storageKey?: unknown }).storageKey === "string"
  );
}

export type ThreadVerdict =
  | { mode: "continue"; messages: unknown[]; summary: string | null; summarizedCount: number }
  | { mode: "fresh"; messages: unknown[]; summary: null; summarizedCount: number };

// S6 matrix: same doc + same agent+skill + thread exists → continue; anything
// else → fresh. Model/provider changes never touch this verdict.
export function resolveHeraldThread(existing: HeraldThread | null, agentId: string | null, skillId: string | null): ThreadVerdict {
  if (existing && existing.agentId === agentId && existing.skillId === skillId) {
    return { mode: "continue", messages: existing.messages, summary: existing.summary, summarizedCount: existing.summarizedCount };
  }
  return { mode: "fresh", messages: [], summary: null, summarizedCount: 0 };
}

// Chat list label: the stored title wins (rename survives); otherwise derive
// once from this send's text. An empty derivation (image-only first message)
// stays NULL until the next send. Agent/skill changes wipe messages but keep
// the title — the verdict mode is irrelevant here.
export function resolveChatTitle(existing: HeraldThread | null, message: string): string | null {
  if (existing?.title) return existing.title;
  return deriveChatTitle(message) || null;
}

export const CHAT_SNIPPET_WINDOW = 40;

export const CHAT_CITATION_CAP = 10;

// Chat citation collector: https-only, URL-deduped, capped per turn.
export function collectCitation(existing: Citation[], c: Citation): Citation[] {
  if (!c.url.startsWith("https://")) return existing;
  if (existing.some((x) => x.url === c.url)) return existing;
  if (existing.length >= CHAT_CITATION_CAP) return existing;
  return [...existing, c];
}

// Edit/regenerate/retry validation: integer within [0, length]; the replaced
// entry (when truncating) must be a user message with string content —
// image-part entries are rejected in v1. Throws InvalidArgs.
export function validateChatFromIndex(messages: unknown[], fromIndex: number): void {
  if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex > messages.length) {
    throw new InvalidArgs({ reason: `fromIndex must be an integer between 0 and ${messages.length}` });
  }
  if (fromIndex < messages.length) {
    const target = messages[fromIndex] as { role?: unknown; content?: unknown } | undefined;
    if (!target || target.role !== "user" || typeof target.content !== "string") {
      throw new InvalidArgs({ reason: "edited turn must target a user message with text content" });
    }
  }
}

// Markdown transcript export. Deterministic template: `# title` header,
// `**You**`/`**Herald**` blocks with a ` · ts` suffix when the entry carries
// one, `[failed turn: CODE]`/`[stopped]` terminal markers, citation lists
// under the turns that produced them.
export function buildChatExport(t: {
  title: string | null;
  messages: unknown[];
}): string {
  const lines: string[] = [`# ${t.title ?? "chat"}`];
  const citeLine = (c: { title: string | null; url: string }) =>
    c.title ? `- [${c.title}](${c.url})` : `- <${c.url}>`;
  for (const raw of t.messages) {
    const m = raw as {
      role?: unknown;
      content?: unknown;
      ts?: unknown;
      citations?: unknown;
      error?: unknown;
      stopped?: unknown;
    };
    if (m.role !== "user" && m.role !== "assistant") continue;
    const who = m.role === "user" ? "You" : "Herald";
    const ts = typeof m.ts === "string" && m.ts !== "" ? ` · ${m.ts}` : "";
    lines.push("");
    lines.push(`**${who}**${ts}`);
    if (typeof m.content === "string") {
      lines.push(m.content);
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        const p = part as { type?: unknown; content?: unknown; text?: unknown };
        if ((p.type === "text" || p.type === undefined) && typeof p.content === "string") {
          lines.push(p.content);
        } else if (typeof p.text === "string") {
          lines.push(p.text);
        } else {
          lines.push("[image]");
        }
      }
    }
    if (Array.isArray(m.citations)) {
      for (const c of m.citations) {
        const cit = c as { title?: unknown; url?: unknown };
        if (typeof cit.url === "string") lines.push(citeLine({ title: typeof cit.title === "string" ? cit.title : null, url: cit.url }));
      }
    }
    if (
      m.error &&
      typeof m.error === "object" &&
      typeof (m.error as { code?: unknown }).code === "string"
    ) {
      lines.push(`[failed turn: ${(m.error as { code: string }).code}]`);
    }
    if (m.stopped === true) lines.push("[stopped]");
  }
  return `${lines.join("\n")}\n`;
}

// Flatten the transcript's string contents and cut a ±window slice around
// the first case-insensitive occurrence of q (mirrors the SQL LIKE
// prefilter's ASCII case-insensitivity). Null when q only matched the title.
export function buildChatSnippet(messages: unknown[], q: string): string | null {
  const flat = messages
    .map((m) => (typeof (m as { content?: unknown }).content === "string" ? (m as { content: string }).content : ""))
    .filter((s) => s !== "")
    .join("\n");
  if (flat === "") return null;
  const idx = flat.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return null;
  const start = Math.max(0, idx - CHAT_SNIPPET_WINDOW);
  const end = Math.min(flat.length, idx + q.length + CHAT_SNIPPET_WINDOW);
  const core = flat.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${core}${end < flat.length ? "…" : ""}`;
}

export function assertAttachmentCaps(
  refs: Array<{ mimeType: string; size: number }>,
  caps: { maxCount: number; maxBytesEach?: number; maxTotalBytes?: number }
): void {
  if (refs.length > caps.maxCount) {
    throw new InvalidArgs({ reason: `at most ${caps.maxCount} images per message` });
  }
  let total = 0;
  for (const ref of refs) {
    if (!IMAGE_MIME_TYPES.includes(ref.mimeType)) {
      throw new InvalidArgs({ reason: `unsupported image type ${ref.mimeType}` });
    }
    if (caps.maxBytesEach !== undefined && ref.size > caps.maxBytesEach) {
      throw new InvalidArgs({ reason: `image exceeds the ${Math.round(caps.maxBytesEach / (1024 * 1024))} MB limit` });
    }
    total += ref.size;
  }
  if (caps.maxTotalBytes !== undefined && total > caps.maxTotalBytes) {
    throw new InvalidArgs({ reason: `images exceed the ${Math.round(caps.maxTotalBytes / (1024 * 1024))} MB request limit` });
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// Replace persisted image-ref parts with base64 data parts. Refs whose blob
// can no longer be loaded are dropped silently — a dead attachment must not
// fail the whole turn.
export async function hydrateImageParts(
  messages: unknown[],
  load: (key: string) => Promise<string | null>
): Promise<ModelMessage[]> {
  const out: ModelMessage[] = [];
  for (const message of messages) {
    const msg = message as ModelMessage;
    if (!Array.isArray(msg.content)) {
      out.push(msg);
      continue;
    }
    const parts: unknown[] = [];
    for (const raw of msg.content) {
      const candidate: unknown = raw;
      if (!isStoredImageRef(candidate)) {
        parts.push(raw);
        continue;
      }
      const base64 = await load(candidate.storageKey).catch(() => null);
      if (base64 === null) continue;
      parts.push({ type: "image", source: { type: "data", value: base64, mimeType: candidate.mimeType } });
    }
    out.push({ ...msg, content: parts } as ModelMessage);
  }
  return out;
}

// Vision-delegation mode: the primary model cannot see images, so image-ref
// parts become text placeholders and the model inspects them via the
// (frame-suppressed) analyze_image tool.
export async function replaceImageRefsWithPlaceholders(messages: unknown[]): Promise<ModelMessage[]> {
  const out: ModelMessage[] = [];
  for (const message of messages) {
    const msg = message as ModelMessage;
    if (!Array.isArray(msg.content)) {
      out.push(msg);
      continue;
    }
    const parts: unknown[] = [];
    for (const raw of msg.content) {
      const candidate: unknown = raw;
      if (!isStoredImageRef(candidate)) {
        parts.push(raw);
        continue;
      }
      parts.push({ type: "text", content: `[attached image: ${candidate.storageKey}]` });
    }
    out.push({ ...msg, content: parts } as ModelMessage);
  }
  return out;
}

export function needsSummary(messages: unknown[]): boolean {
  if (messages.length > SUMMARY_THRESHOLD_MESSAGES) return true;
  try {
    return JSON.stringify(messages).length > SUMMARY_THRESHOLD_BYTES;
  } catch {
    return false;
  }
}

const activeTasks = new Map<string, AbortController>();
const activeChats = new Map<string, AbortController>();

// Internal vision-delegation tool — its frames are suppressed from the
// member-facing stream (docs/SCHEMA.md Hearth: vision chain outcome 2).
const INTERNAL_TOOL = "analyze_image";

// Stall watchdog: a provider connection that delivers no chunk (of any type)
// for this long is treated as dead — aborted and failed so the UI shows a
// failed turn with Retry instead of an infinite spinner.
export const STREAM_STALL_TIMEOUT_MS = 90_000;
export const STREAM_STALL_MESSAGE = "stream stalled — no response from provider";

export function shouldEmitToolFrame(name: string): boolean {
  return name !== INTERNAL_TOOL;
}

export interface StreamRunContext {
  keyId: string;
  idField: "taskId" | "chatId";
  threadId: string;
  registry: Map<string, AbortController>;
  config: ProviderConfig;
  systemPrompts: CacheablePrompt[];
  history: unknown[];
  userTs: string;
  getCitations: () => Array<{ title: string | null; url: string }>;
  userContent: string | unknown[];
  tools: ReadonlyArray<unknown>;
  toolRoundCap: number;
  loadImageBase64: (key: string) => Promise<string | null>;
  imageMode: VisionMode;
  historySummary: () => string | null;
  historySummarizedCount: () => number;
  persist: (messages: unknown[], summary: string | null, summarizedCount: number) => Promise<void>;
  onDone: (text: string) => Promise<void>;
  onFail: (message: string) => Promise<void>;
  onCancel: () => Promise<void>;
}

export function buildStream(ctx: StreamRunContext): ReadableStream<StreamFrame> {
  return new ReadableStream<StreamFrame>({
    start(controller) {
      const abort = new AbortController();
      ctx.registry.set(ctx.keyId, abort);
      let closed = false;
      const push = (frame: StreamFrame) => {
        if (!closed) controller.enqueue(frame);
      };
      void (async () => {
        let text = "";
        let usageIn = 0;
        let usageOut = 0;
        // Set when the STALL watchdog fired — its abort must not be
        // misclassified as a client abort in the catch below.
        let stalled = false;
        const userEntry = { role: "user", content: ctx.userContent, ts: ctx.userTs };
        // Failure/abort terminal persist — runs BEFORE onFail/onCancel so a
        // retry can drop the failed entry by re-sending from its index.
        const persistTerminalTurn = async (extra: Record<string, unknown>) => {
          await ctx.persist(
            [
              ...ctx.history,
              userEntry,
              { role: "assistant", content: text, ts: new Date().toISOString(), ...extra },
            ],
            ctx.historySummary(),
            ctx.historySummarizedCount()
          );
        };
        try {
          push({ type: "start", [ctx.idField]: ctx.keyId, threadId: ctx.threadId } as StreamFrame);
          const prepared = ctx.imageMode === "delegate"
            ? await replaceImageRefsWithPlaceholders([...ctx.history, userEntry])
            : await hydrateImageParts([...ctx.history, userEntry], ctx.loadImageBase64);
          let toolRounds = 0;
          // Accumulated tool-call args per toolCallId: TOOL_CALL_START carries
          // only the name; the args stream in via TOOL_CALL_ARGS chunks.
          const pendingCalls = new Map<string, { name: string; args: string }>();
          const consume = async (tools: ReadonlyArray<unknown> | undefined) => {
            const chunks = streamChat({
              config: ctx.config,
              systemPrompts: ctx.systemPrompts,
              messages: prepared,
              tools,
              abortController: abort,
            });
            const iterator = chunks[Symbol.asyncIterator]();
            for (;;) {
              // Stall watchdog: race each chunk against a fresh timer, reset
              // on every chunk (any type). On timeout abort the provider
              // request and fail the turn — never spin forever.
              const next = iterator.next();
              next.catch(() => {});
              let result: IteratorResult<StreamChunk>;
              let stallTimer: ReturnType<typeof setTimeout> | undefined;
              try {
                result = await Promise.race([
                  next,
                  new Promise<never>((_, reject) => {
                    stallTimer = setTimeout(() => {
                      stalled = true;
                      abort.abort();
                      reject(new HeraldGenerationFailed({ message: STREAM_STALL_MESSAGE }));
                    }, STREAM_STALL_TIMEOUT_MS);
                  }),
                ]);
              } finally {
                clearTimeout(stallTimer);
              }
              if (result.done) break;
              const chunk = result.value;
              if (chunk.type === "TEXT_MESSAGE_CONTENT") {
                text += chunk.delta;
                push({ type: "delta", text: chunk.delta });
              } else if (chunk.type === "REASONING_MESSAGE_CONTENT") {
                // Ephemeral chain-of-thought — streamed, never persisted.
                push({ type: "reasoning", delta: chunk.delta });
              } else if (chunk.type === "TOOL_CALL_START") {
                const id = chunk.toolCallId !== undefined ? String(chunk.toolCallId) : "";
                pendingCalls.set(id, { name: chunk.toolCallName ?? chunk.toolName ?? "", args: "" });
              } else if (chunk.type === "TOOL_CALL_ARGS") {
                const pending = pendingCalls.get(chunk.toolCallId !== undefined ? String(chunk.toolCallId) : "");
                if (pending) {
                  const piece = typeof chunk.args === "string" ? chunk.args : typeof chunk.delta === "string" ? chunk.delta : "";
                  pending.args += piece;
                }
              } else if (chunk.type === "TOOL_CALL_END") {
                toolRounds += 1;
                const id = chunk.toolCallId !== undefined ? String(chunk.toolCallId) : "";
                const pending = pendingCalls.get(id);
                pendingCalls.delete(id);
                const name = chunk.toolCallName ?? chunk.toolName ?? pending?.name ?? "";
                let detail: string | undefined;
                if (pending && pending.args !== "") {
                  try {
                    detail = toolCallDetail(name, JSON.parse(pending.args));
                  } catch {
                    detail = undefined;
                  }
                }
                if (shouldEmitToolFrame(name)) {
                  push(detail === undefined ? { type: "tool", phase: "call", name } : { type: "tool", phase: "call", name, detail });
                  push(detail === undefined ? { type: "tool", phase: "result", name } : { type: "tool", phase: "result", name, detail });
                }
                if (toolRounds > ctx.toolRoundCap) {
                  abort.abort();
                  throw new HeraldToolBudgetExceeded({ rounds: ctx.toolRoundCap });
                }
              } else if (chunk.type === "RUN_FINISHED") {
                const u = chunk.usage as
                  | { input?: number; output?: number; promptTokens?: number; completionTokens?: number }
                  | undefined;
                usageIn = Number(u?.input ?? u?.promptTokens ?? usageIn);
                usageOut = Number(u?.output ?? u?.completionTokens ?? usageOut);
              } else if (chunk.type === "RUN_ERROR") {
                throw translateRunError(new Error(chunk.message));
              }
            }
          };
          await consume(ctx.tools);
          // Some OpenAI-compatible providers/models reject function calling
          // with a normal finish and empty content (no RUN_ERROR). One
          // degraded retry without tools beats a silent empty reply.
          if (text === "" && ctx.tools && ctx.tools.length > 0) {
            await consume(undefined);
          }
          const citations = ctx.getCitations();
          const finalMessages = [
            ...ctx.history,
            userEntry,
            { role: "assistant", content: text, ts: new Date().toISOString(), ...(citations.length > 0 ? { citations } : {}) },
          ];
          let summary = ctx.historySummary();
          let summarizedCount = ctx.historySummarizedCount();
          let kept = finalMessages;
          if (needsSummary(finalMessages)) {
            const older = finalMessages.slice(0, finalMessages.length - SUMMARY_WINDOW);
            const condensed = await summarizeOlder(ctx.config, older).catch(() => null);
            if (condensed !== null) {
              summarizedCount += older.length;
              summary = condensed;
              kept = finalMessages.slice(-SUMMARY_WINDOW);
            }
          }
          await ctx.persist(kept, summary, summarizedCount);
          await ctx.onDone(text);
          push({ type: "done", [ctx.idField]: ctx.keyId, text, usage: { in: usageIn, out: usageOut } } as StreamFrame);
        } catch (e) {
          if (e instanceof HeraldToolBudgetExceeded) {
            await persistTerminalTurn({
              error: { code: "HERALD_TOOL_BUDGET_EXCEEDED", message: `Herald exceeded its tool budget (${e.rounds} rounds)` },
            }).catch(() => {});
            await ctx.onFail(`Herald exceeded its tool budget (${e.rounds} rounds)`).catch(() => {});
            push({ type: "error", code: "HERALD_TOOL_BUDGET_EXCEEDED", message: `Herald exceeded its tool budget (${e.rounds} rounds)` });
          } else if (abort.signal.aborted && !stalled) {
            // Client abort with partial text → keep the fragment, marked
            // stopped. No text → nothing gained, persist nothing.
            if (text !== "") {
              await persistTerminalTurn({ stopped: true }).catch(() => {});
            }
            await ctx.onCancel().catch(() => {});
          } else {
            const err = translateRunError(e);
            const code = errorCodeMap[err._tag] ?? "HERALD_GENERATION_FAILED";
            const message = String(err.message ?? "Herald generation failed");
            await persistTerminalTurn({ error: { code, message } }).catch(() => {});
            await ctx.onFail(String(err.message ?? "").slice(0, 2000)).catch(() => {});
            push({
              type: "error",
              code,
              message,
            });
          }
        } finally {
          ctx.registry.delete(ctx.keyId);
          closed = true;
          try {
            controller.close();
          } catch {
            // request already torn down (client disconnect / server idle timeout)
          }
        }
      })();
    },
    cancel() {
      const abort = ctx.registry.get(ctx.keyId);
      abort?.abort();
    },
  });
}

async function summarizeOlder(config: ProviderConfig, older: unknown[]): Promise<string> {
  return completeText(config, {
    systemPrompts: [
      { content: "You condense working conversations. Reply with a terse bullet summary of decisions, constraints and open threads only." },
    ],
    messages: [
      { role: "user", content: `Summarize these earlier conversation turns for continuity:\n\n${JSON.stringify(older).slice(0, 60000)}` },
    ],
  });
}

export class HeraldService extends Effect.Service<HeraldService>()("Lexa/Herald", {
  dependencies: [
    ForgeRepo.Default,
    HeraldSettingsRepo.Default,
    HeraldThreadRepo.Default,
    ProjectMemoryRepo.Default,
    ForgeService.Default,
    Storage.Default,
    TaskRepo.Default,
    WikiRepo.Default,
    ProjectReposRepo.Default,
  ],
  effect: Effect.gen(function* () {
    const forgeRepo = yield* ForgeRepo;
    const settingsRepo = yield* HeraldSettingsRepo;
    const threadRepo = yield* HeraldThreadRepo;
    const memoryRepo = yield* ProjectMemoryRepo;
    const forgeService = yield* ForgeService;
    const storage = yield* Storage;
    const taskRepo = yield* TaskRepo;
    const wikiRepo = yield* WikiRepo;
    const db = yield* Sqlite;

    const configFromRow = (row: HeraldSettingsRow): ProviderConfig => ({
      kind: row.kind,
      baseUrl: row.base_url,
      apiKey: row.api_key,
      model: row.model,
    });

    // Vision delegation runs on the PRIMARY provider (same kind/base_url/
    // api_key) — only the model differs.
    const visionConfigOf = (row: HeraldSettingsRow): ProviderConfig => ({
      kind: row.kind,
      baseUrl: row.base_url,
      apiKey: row.api_key,
      model: row.vision_model ?? "",
    });

    const resolveMimeType = (projectId: string, key: string): Promise<string> =>
      Promise.resolve(
        (
          db.prepare(`SELECT mime_type FROM attachments WHERE project_id = ? AND storage_key = ? LIMIT 1`).get(projectId, key) as
            | { mime_type?: string }
            | undefined
        )?.mime_type ?? "image/png"
      );

    const skillJunctionBound = (agentId: string, skillId: string): boolean =>
      db.prepare(`SELECT 1 FROM lexa_agent_skills WHERE agent_id = ? AND skill_id = ? LIMIT 1`).get(agentId, skillId) !== null;

    const getSettingsOrFail = (projectId: string) =>
      settingsRepo.getByProject(projectId).pipe(
        Effect.catchTag("RowNotFound", () => new ProviderNotConfigured({ projectId }))
      );

    const taskRefOf = (t: Task): TaskRef => ({
      id: t.id,
      key: t.key,
      title: t.title,
      priority: t.priority,
      dueAt: t.dueAt,
      archivedAt: t.archivedAt,
      markdown: docToMarkdown(t.description as TipTapDoc),
    });

    const loadDocContext = (
      projectId: string,
      documentType: "task" | "wiki",
      documentId: string
    ): Effect.Effect<{ title: string; context: string }, TaskNotFound | WikiPageNotFound | DbError | RowNotFound> =>
      Effect.gen(function* () {
        if (documentType === "task") {
          const t = yield* taskRepo.findById(documentId).pipe(
            Effect.catchTag("RowNotFound", () => new TaskNotFound({ id: documentId }))
          );
          const md = docToMarkdown(t.description as TipTapDoc);
          return { title: t.title, context: `Task: ${t.key} — ${t.title}${md ? `\nDescription:\n${md}` : ""}` };
        }
        const page = yield* wikiRepo.findBySlug(projectId, documentId).pipe(
          Effect.catchTag("RowNotFound", () => new WikiPageNotFound({ id: documentId }))
        );
        const md = docToMarkdown(page.content as TipTapDoc);
        return { title: page.title, context: `Wiki page: ${page.title}${md ? `\n${md}` : ""}` };
      });

    const loadImageBase64 = (key: string): Promise<string | null> =>
      Effect.runPromise(Effect.map(storage.get(key), bytesToBase64)).catch(() => null);

    // Resolve @KEY / @slug tokens in a chat message to a bounded ephemeral
    // context block. Task-key grammar wins on ambiguity; duplicates resolve
    // once; unknown tokens are ignored silently.
    const resolveMentionContext = (projectId: string, message: string): Effect.Effect<string, DbError> =>
      Effect.gen(function* () {
        const tokens = scanMentionTokens(message);
        if (tokens.length === 0) return "";
        const seen = new Set<string>();
        const resolved: ResolvedMention[] = [];
        for (const token of tokens) {
          if (resolved.length >= MENTION_CAPS.maxMentions) break;
          const parsed = parseTaskKey(token);
          if (parsed) {
            const dedupeKey = `task:${parsed.prefix}-${parsed.number}`;
            if (seen.has(dedupeKey)) continue;
            const t = yield* taskRepo.findByKey(`${parsed.prefix}-${parsed.number}`).pipe(
              Effect.catchTag("RowNotFound", () => Effect.succeed(null)),
              Effect.catchAll(() => Effect.succeed(null))
            );
            if (!t || t.projectId !== projectId) continue;
            seen.add(dedupeKey);
            resolved.push({
              kind: "task",
              id: t.id,
              label: `${t.key} — ${t.title}`,
              text: extractText(t.description as TipTapDoc),
            });
          } else {
            const slug = token.toLowerCase();
            const dedupeKey = `wiki:${slug}`;
            if (seen.has(dedupeKey)) continue;
            const page = yield* wikiRepo.findBySlug(projectId, token).pipe(
              Effect.catchTag("RowNotFound", () =>
                wikiRepo.findBySlug(projectId, slug).pipe(
                  Effect.catchTag("RowNotFound", () => Effect.succeed(null)),
                  Effect.catchAll(() => Effect.succeed(null))
                )
              ),
              Effect.catchAll(() => Effect.succeed(null))
            );
            if (!page) continue;
            seen.add(dedupeKey);
            resolved.push({
              kind: "wiki",
              id: page.id,
              label: page.title,
              text: extractText(page.content as TipTapDoc),
            });
          }
        }
        return buildMentionContextBlock(resolved);
      });

    const validateAttachments = (
      projectId: string,
      attachments: ReadonlyArray<{ storageKey: string; mimeType: string }>,
      caps: { maxCount: number; maxBytesEach?: number; maxTotalBytes?: number }
    ): Effect.Effect<void, InvalidArgs | DbError> =>
      Effect.gen(function* () {
        for (const a of attachments) {
          const scoped =
            db.prepare(`SELECT 1 FROM attachments WHERE project_id = ? AND storage_key = ? LIMIT 1`).get(projectId, a.storageKey) !==
            null;
          if (!scoped) {
            return yield* new InvalidArgs({ reason: `attachment '${a.storageKey}' does not belong to this project` });
          }
        }
        const sized = yield* Effect.forEach(attachments, (a) =>
          storage.stat(a.storageKey).pipe(
            // Dead blob → size 0; hydration drops missing refs silently anyway.
            Effect.catchTag("StorageError", () => Effect.succeed(null)),
            Effect.map((size) => ({ mimeType: a.mimeType, size: size ?? 0 }))
          )
        );
        yield* Effect.try({
          try: () => assertAttachmentCaps(sized, caps),
          catch: (e) => e as InvalidArgs,
        });
      });

    const buildToolDeps = (projectId: string, allowlist: string | null, searchApiKey: string | null) => ({
      projectId,
      allowlist,
      searchApiKey,
      fetchImpl: fetch,
      storageGet: (key: string) => Effect.runPromise(storage.get(key)),
      projectOwnsStorageKey: (pid: string, key: string) =>
        Promise.resolve(
          db.prepare(`SELECT 1 FROM attachments WHERE project_id = ? AND storage_key = ? LIMIT 1`).get(pid, key) !== null
        ),
      findTaskByRef: async (ref: string) => {
        const t = await Effect.runPromise(
          taskRepo.findById(ref).pipe(Effect.orElse(() => taskRepo.findByKey(ref)))
        ).catch(() => null);
        if (!t || t.projectId !== projectId) return null;
        return taskRefOf(t);
      },
      searchTasksByTitle: async (query: string, limit = 10) => {
        const rows = await Effect.runPromise(taskRepo.searchByTitle(projectId, query, limit)).catch(() => [] as Task[]);
        return rows.map(taskRefOf);
      },
      searchWikiPages: async (query: string, limit = 10) => {
        const rows = await Effect.runPromise(wikiRepo.search(projectId, query, limit)).catch(() => []);
        return rows.map((p) => ({ title: p.title, slug: p.slug, snippet: p.snippet }));
      },
      findWikiPageBySlug: async (slug: string) => {
        const page = await Effect.runPromise(wikiRepo.findBySlug(projectId, slug)).catch(() => null);
        if (!page) return null;
        return { title: page.title, slug: page.slug, content: page.content as TipTapDoc };
      },
    });

    return {
      // Queue row only — runtime-online guard deliberately skipped (S2).
      enqueue: (input: {
        projectId: string;
        documentType: "task" | "wiki";
        documentId: string;
        prompt: string;
        agentId: string;
        skillId: string;
        selection?: string;
        attachments?: Array<{ storageKey: string; mimeType: string; name: string }>;
      }) =>
        Effect.gen(function* () {
          const settingsRow = yield* getSettingsOrFail(input.projectId);
          yield* forgeRepo.findAgentById(input.agentId).pipe(
            Effect.catchTag("RowNotFound", () => new AgentNotFound({ id: input.agentId }))
          );
          yield* forgeRepo.findSkillById(input.skillId).pipe(
            Effect.catchTag("RowNotFound", () => new SkillNotFound({ id: input.skillId }))
          );
          const engine = settingsRow.engine;
          const engineAgentId = engine === "blacksmith" ? BLACKSMITH_AGENT.id : HERALD_AGENT.id;
          if (!skillJunctionBound(engineAgentId, input.skillId)) {
            return yield* new SkillNotFound({ id: input.skillId });
          }
          if (input.documentType === "task") {
            yield* taskRepo.findById(input.documentId).pipe(
              Effect.catchTag("RowNotFound", () => new TaskNotFound({ id: input.documentId }))
            );
          } else {
            yield* wikiRepo.findBySlug(input.projectId, input.documentId).pipe(
              Effect.catchTag("RowNotFound", () => new WikiPageNotFound({ id: input.documentId }))
            );
          }
          if (engine === "blacksmith") {
            const runtimes = yield* forgeRepo.listRuntimes();
            if (!runtimes.some((r) => r.status === "online")) {
              return yield* new NoRuntimeOnline();
            }
          }
          const attachments = input.attachments ?? [];
          if (attachments.length > 0) {
            yield* validateAttachments(input.projectId, attachments, DOC_IMAGE_CAPS);
            if (resolveVisionMode(settingsRow) === "none") {
              return yield* new VisionNotConfigured();
            }
            const existing = yield* threadRepo.loadThread(input.documentType, input.documentId).pipe(
              Effect.catchTag("RowNotFound", () => Effect.succeed(null))
            );
            const verdict = resolveHeraldThread(existing, input.agentId, input.skillId);
            yield* threadRepo.saveThread(input.documentType, input.documentId, {
              projectId: input.projectId,
              agentId: input.agentId,
              skillId: input.skillId,
              messages: [
                ...verdict.messages,
                {
                  role: "user",
                  content: attachments.map((a) => ({ type: "image-ref", storageKey: a.storageKey, mimeType: a.mimeType })),
                },
              ],
              summary: verdict.summary,
              summarizedCount: verdict.summarizedCount,
            });
          }
          // Blacksmith rows carry document context like ForgeService.create —
          // the daemon builds its prompt from the claim payload alone.
          const docContext = engine === "blacksmith"
            ? (yield* loadDocContext(input.projectId, input.documentType, input.documentId)).context
            : "";
          return yield* forgeRepo.createTask({
            id: crypto.randomUUID(),
            projectId: input.projectId,
            documentType: input.documentType,
            documentId: input.documentId,
            agentId: input.agentId,
            skillId: input.skillId,
            extraPrompt: input.prompt,
            selection: input.selection ?? "",
            docContext,
            kind: engine,
          });
        }),

      resetThread: (projectId: string, documentType: "task" | "wiki", documentId: string) =>
        Effect.gen(function* () {
          const tasks = yield* forgeRepo.listTasksForDocument(projectId, documentType, documentId);
          if (tasks.some((t) => t.kind === "herald" && t.status === "running")) {
            return yield* new HeraldTaskActive();
          }
          yield* threadRepo.resetThread(documentType, documentId).pipe(
            Effect.catchTag("RowNotFound", () => new HeraldThreadNotFound({ documentType, documentId }))
          );
        }),

      testConnection: (config: ProviderConfig) =>
        Effect.tryPromise({
          try: () => providerTestConnection(config),
          catch: (e) => e as ProviderAuthFailed | ProviderUnreachable | HeraldGenerationFailed,
        }),

      abortStream: (taskId: string): boolean => {
        activeTasks.get(taskId)?.abort();
        return activeTasks.has(taskId);
      },

      abortChat: (chatId: string): boolean => {
        activeChats.get(chatId)?.abort();
        return activeChats.has(chatId);
      },

      chatActive: (chatId: string): boolean => activeChats.has(chatId),

      runStream: (taskId: string) =>
        Effect.gen(function* () {
          const task = yield* forgeRepo.claimHeraldTask(taskId).pipe(
            Effect.catchTag("ConstraintViolation", () => new HeraldTaskActive()),
            Effect.catchTag("RowNotFound", () => new ForgeTaskNotFound({ id: taskId }))
          );
          const settingsRow = yield* getSettingsOrFail(task.projectId);
          const config = configFromRow(settingsRow);

          const existing = yield* threadRepo.loadThread(task.documentType, task.documentId).pipe(
            Effect.catchTag("RowNotFound", () => Effect.succeed(null))
          );
          const verdict = resolveHeraldThread(existing, task.agentId, task.skillId);

          const agent = yield* forgeRepo.findAgentById(task.agentId).pipe(
            Effect.catchTag("RowNotFound", () => new AgentNotFound({ id: task.agentId }))
          );
          const skill = yield* forgeRepo.findSkillById(task.skillId).pipe(
            Effect.catchTag("RowNotFound", () => new SkillNotFound({ id: task.skillId }))
          );

          const doc = yield* loadDocContext(task.projectId, task.documentType, task.documentId);
          const repoContent = yield* loadTaskRepoContent(task).pipe(Effect.catchAll(() => Effect.succeed([])));
          const memoryHits = yield* memoryRepo.searchByProject(task.projectId, extractMemoryTerms(doc.title, doc.context));

          const systemPrompts = buildSystemPrompts({
            identity: IDENTITY,
            memoryBlock: memoryBlockFromHits(memoryHits),
            agentMarkdown: agent.instructions,
            skillMarkdown: skill.instructions,
            repoContent,
            docContext: doc.context,
          });

          const imageMode = resolveVisionMode(settingsRow);
          const baseTools = buildHeraldTools(buildToolDeps(task.projectId, settingsRow.url_allowlist, settingsRow.search_api_key));
          const tools =
            imageMode === "delegate"
              ? [
                  ...baseTools,
                  buildAnalyzeImageTool({
                    config: visionConfigOf(settingsRow),
                    loadImageBase64,
                    resolveMimeType: (key) => resolveMimeType(task.projectId, key),
                    fetchImpl: fetch,
                  }),
                ]
              : baseTools;

          const instruction = [
            task.selection ? `Selected text:\n"""\n${task.selection}\n"""` : null,
            task.extraPrompt,
          ]
            .filter((s): s is string => !!s && s.trim() !== "")
            .join("\n\n");
          const userContent = buildUserMessage({
            instruction,
            summary: verdict.summary,
            summarizedCount: verdict.summarizedCount,
          });

          return buildStream({
            keyId: taskId,
            idField: "taskId",
            threadId: task.documentId,
            registry: activeTasks,
            config,
            systemPrompts,
            history: verdict.messages,
            userTs: new Date().toISOString(),
            getCitations: () => [],
            historySummary: () => verdict.summary,
            historySummarizedCount: () => verdict.summarizedCount,
            userContent,
            tools,
            toolRoundCap: MAX_TOOL_ROUNDS,
            loadImageBase64,
            imageMode,
            persist: (messages, summary, summarizedCount) =>
              Effect.runPromise(
                threadRepo.saveThread(task.documentType, task.documentId, {
                  projectId: task.projectId,
                  agentId: task.agentId,
                  skillId: task.skillId,
                  messages,
                  summary,
                  summarizedCount,
                })
              ).then(() => {}),
            onDone: (text) =>
              Effect.runPromise(forgeService.complete(taskId, text))
                .then(() => {})
                .catch(() => {}),
            onFail: (message) =>
              Effect.runPromise(forgeService.fail(taskId, message))
                .then(() => {})
                .catch(() => {}),
            onCancel: async () => {
              await Effect.runPromise(forgeService.cancel(taskId)).catch(() => {});
              await Effect.runPromise(
                forgeRepo.appendLog(crypto.randomUUID(), taskId, "aborted")
              ).catch(() => {});
            },
          });
        }),

      runChatStream: (chatId: string, userId: string, req: HeraldChatStreamRequest) =>
        Effect.gen(function* () {
          if (activeChats.has(chatId)) return yield* new HeraldTaskActive();
          const settingsRow = yield* getSettingsOrFail(req.projectId);
          // Freeform chat ALWAYS runs the herald lane — a blacksmith project
          // default fails the send before any thread write or stream start.
          if (settingsRow.engine === "blacksmith") {
            return yield* new EngineNotSupportedForChat({ engine: settingsRow.engine });
          }
          const config = configFromRow(settingsRow);

          if (req.skillId !== undefined && !skillJunctionBound(HERALD_AGENT.id, req.skillId)) {
            return yield* new SkillNotFound({ id: req.skillId });
          }

          const attachments = req.attachments ?? [];
          const imageMode = resolveVisionMode(settingsRow);
          yield* validateAttachments(req.projectId, attachments, CHAT_IMAGE_CAPS);
          if (attachments.length > 0 && imageMode === "none") {
            return yield* new VisionNotConfigured();
          }

          // @-mention resolution at send: task-key grammar wins on ambiguity,
          // duplicates resolve once, unknown tokens are ignored. The resolved
          // content rides ONLY in the ephemeral system prompts — the persisted
          // user message stays the raw text verbatim.
          const mentionContext = yield* resolveMentionContext(req.projectId, req.message);

          const existing = yield* threadRepo.loadChat(chatId, userId).pipe(
            Effect.catchTag("RowNotFound", () => Effect.succeed(null))
          );
          let verdict = resolveHeraldThread(existing, req.agentId ?? null, req.skillId ?? null);
          const title = resolveChatTitle(existing, req.message);

          // Edit/regenerate/retry: validate fromIndex against the CURRENT
          // transcript, truncate pre-persist, re-resolve on the shortened
          // history. Title and pin survive truncation.
          if (req.fromIndex !== undefined) {
            const fromIndex = req.fromIndex;
            yield* Effect.try({
              try: () => validateChatFromIndex(verdict.messages, fromIndex),
              catch: (e) => e as InvalidArgs,
            });
            if (fromIndex < verdict.messages.length) {
              const truncated = yield* threadRepo.truncateChatFrom(chatId, userId, fromIndex);
              verdict = resolveHeraldThread(truncated, req.agentId ?? null, req.skillId ?? null);
            }
          }

          const memoryHits = yield* memoryRepo.searchByProject(req.projectId, extractMemoryTerms(req.message, ""));
          const systemPrompts = buildSystemPrompts({
            identity: CHAT_IDENTITY,
            memoryBlock: memoryBlockFromHits(memoryHits),
            agentMarkdown: null,
            skillMarkdown: null,
            mentionContext,
          });

          const refs: unknown[] = attachments.map((a) => ({
            type: "image-ref",
            storageKey: a.storageKey,
            mimeType: a.mimeType,
          }));
          const userContent: string | unknown[] =
            refs.length > 0 ? [{ type: "text", content: req.message }, ...refs] : req.message;

          // Per-turn citation collector fed by the web_search/fetch_url tools.
          let citations: Citation[] = [];
          return buildStream({
            keyId: chatId,
            idField: "chatId",
            threadId: chatId,
            registry: activeChats,
            config,
            systemPrompts,
            history: verdict.messages,
            userTs: new Date().toISOString(),
            getCitations: () => citations,
            userContent,
            tools: (() => {
              const base = buildHeraldTools({
                ...buildToolDeps(req.projectId, settingsRow.url_allowlist, settingsRow.search_api_key),
                onCitation: (c) => {
                  citations = collectCitation(citations, c);
                },
              });
              return imageMode === "delegate" && attachments.length > 0
                ? [
                    ...base,
                    buildAnalyzeImageTool({
                      config: visionConfigOf(settingsRow),
                      loadImageBase64,
                      resolveMimeType: (key) => resolveMimeType(req.projectId, key),
                      fetchImpl: fetch,
                    }),
                  ]
                : base;
            })(),
            toolRoundCap: MAX_CHAT_TOOL_ROUNDS,
            loadImageBase64,
            imageMode: attachments.length > 0 ? imageMode : "inline",
            historySummary: () => verdict.summary,
            historySummarizedCount: () => verdict.summarizedCount,
            persist: (messages, summary, summarizedCount) =>
              Effect.runPromise(
                threadRepo.saveThread("chat", chatId, {
                  projectId: req.projectId,
                  ownerUserId: userId,
                  title,
                  agentId: req.agentId ?? null,
                  skillId: req.skillId ?? null,
                  messages,
                  summary,
                  summarizedCount,
                })
              ).then(() => {}),
            onDone: () => Promise.resolve(),
            onFail: () => Promise.resolve(),
            onCancel: () => Promise.resolve(),
          });
        }),

      // Owner-scoped chat history list (sidebar): pinned first, then newest.
      // Optional q prefilter + transcript snippet for search UIs.
      listChats: (projectId: string, userId: string, opts: { q?: string } = {}) =>
        Effect.map(
          threadRepo.listChats(projectId, userId, { q: opts.q }),
          (rows) =>
            rows.map((t) => ({
              chatId: t.documentId,
              title: t.title,
              pinned: t.pinned,
              snippet: opts.q ? buildChatSnippet(t.messages, opts.q) : null,
              createdAt: t.createdAt,
              updatedAt: t.updatedAt,
            }))
        ),

      updateChatMeta: (chatId: string, userId: string, patch: { title?: string; pinned?: boolean }) =>
        Effect.gen(function* () {
          const next: { title?: string; pinned?: boolean } = {};
          if (patch.title !== undefined) {
            const trimmed = patch.title.trim();
            if (trimmed === "" || trimmed.length > 200) {
              return yield* new InvalidArgs({ reason: "title must be 1-200 characters" });
            }
            next.title = trimmed;
          }
          if (patch.pinned !== undefined) {
            next.pinned = patch.pinned;
          }
          if (next.title === undefined && next.pinned === undefined) {
            return yield* new InvalidArgs({ reason: "nothing to update — provide title or pinned" });
          }
          return yield* threadRepo.updateChatMeta(chatId, userId, next);
        }),
    };
  }),
}) {}
