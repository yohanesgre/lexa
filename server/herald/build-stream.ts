import { translateRunError } from "./provider";
import { MAX_CHAT_TOOL_ROUNDS, MAX_TOOL_ROUNDS, toolCallDetail } from "./tools";
import { isHeraldWriteTool, type QueuedProposal } from "./write-tools";
import { HeraldGenerationFailed, HeraldToolBudgetExceeded } from "../api/errors";
import type { HeraldReasoningEffort, StreamFrame } from "../../shared/herald";
import { HERALD_STALL_TIMEOUT_MS, HERALD_STALL_MESSAGE } from "../../shared/herald";
import type { ModelMessage, StreamChunk } from "@tanstack/ai";
import { hydrateImageParts, replaceImageRefsWithPlaceholders, needsSummary } from "../services/herald-helpers";

export const STREAM_STALL_TIMEOUT_MS = HERALD_STALL_TIMEOUT_MS;
export const STREAM_STALL_MESSAGE = HERALD_STALL_MESSAGE;
export const ZERO_ARG_TOOLS = new Set(["get_all_tasks", "get_all_wiki_pages", "get_board_structure"]);
const INTERNAL_TOOL = "analyze_image";

export const HALLUCINATION_RE = /(sudah dibuat|berhasil dibuat|successfully created|has been created|created successfully)/i;
export const WRITE_INTENT_RE =
  /\b(bikin|buat|tambah|create|update|archive|edit|hapus)\b.*\b(milestone|sprint|task|wiki|page|comment)\b|\b(bikin|buat)\s+(milestone|sprint|task)\b|\bcreate\s+(milestone|sprint|task|wiki)\b/i;
function extractUserText(content: string | unknown[]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Array<{ type?: unknown; content?: unknown; text?: unknown }>)
      .map((p) => {
        if (typeof p.content === "string") return p.content;
        if (typeof p.text === "string") return p.text;
        return "";
      })
      .join(" ");
  }
  return "";
}
export function shouldEmitToolFrame(name: string): boolean { return name !== INTERNAL_TOOL; }
export function stripToolCallXml(text: string): string { return text.replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/gi, "").trim(); }
function stripToolCallXmlRaw(text: string): string { return text.replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/gi, ""); }

function pendingBatchIdOf(pb: unknown): string | null {
  if (typeof pb === "string") return pb;
  if (pb && typeof pb === "object" && typeof (pb as { batchId?: unknown }).batchId === "string") return (pb as { batchId: string }).batchId;
  return null;
}
export function findPendingBatch(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { pendingBatch?: unknown } | null;
    const id = m && typeof m === "object" ? pendingBatchIdOf(m.pendingBatch) : null;
    if (id !== null) return id;
  }
  return null;
}
export function applyResumeResults(messages: unknown[], resolvedBatchIds: string[]): unknown[] {
  const done = new Set(resolvedBatchIds);
  return messages.map((m) => {
    const id = pendingBatchIdOf((m as { pendingBatch?: unknown } | null)?.pendingBatch);
    if (id !== null && done.has(id)) { const { pendingBatch: _resolved, ...rest } = m as Record<string, unknown>; return rest; }
    return m;
  });
}

export interface StreamRunContext {
  keyId: string;
  idField: "taskId" | "chatId";
  threadId: string;
  registry: Map<string, AbortController>;
  config: import("./provider").ProviderConfig;
  systemPrompts: import("./prompt").CacheablePrompt[];
  history: unknown[];
  userTs: string;
  getCitations: () => Array<{ title: string | null; url: string }>;
  userContent: string | unknown[];
  tools: ReadonlyArray<unknown>;
  toolRoundCap: number;
  loadImageBase64: (key: string) => Promise<string | null>;
  imageMode: import("./vision").VisionMode;
  historySummary: () => string | null;
  historySummarizedCount: () => number;
  persist: (messages: unknown[], summary: string | null, summarizedCount: number) => Promise<void>;
  onDone: (text: string) => Promise<void>;
  onFail: (message: string) => Promise<void>;
  onCancel: () => Promise<void>;
  skipUserEntry?: boolean | undefined;
  approvalResults?: Array<{ approvalId: string; status: "applied" | "failed" | "denied"; error?: string }> | undefined;
  writeDrain?: (() => QueuedProposal[]) | undefined;
  writeTools?: string[] | undefined;
  modelOptions?: Record<string, unknown> | undefined;
  gatewayStream?: ((input: unknown) => AsyncIterable<StreamChunk>) | undefined;
}

async function summarizeOlder(config: import("./provider").ProviderConfig, older: unknown[], sessionId: string): Promise<string> {
  const { completeText } = await import("./provider");
  return completeText(config, {
    systemPrompts: [{ content: "You condense working conversations. Reply with a terse bullet summary of decisions, constraints and open threads only." }],
    messages: [{ role: "user", content: `Summarize these earlier conversation turns for continuity:\n\n${JSON.stringify(older).slice(0, 60000)}` }],
  }, { sessionId });
}

export function buildStream(ctx: StreamRunContext): ReadableStream<StreamFrame> {
  return new ReadableStream<StreamFrame>({
    start(controller) {
      const existing = ctx.registry.get(ctx.keyId);
      const abort = existing ?? new AbortController();
      if (!existing) ctx.registry.set(ctx.keyId, abort);
      let closed = false;
      const push = (frame: StreamFrame) => { if (!closed) controller.enqueue(frame); };
      void (async () => {
        let text = "";
        let usageIn = 0;
        let usageOut = 0;
        let stalled = false;
        const isEmptyUserContent = (c: string | unknown[]): boolean => {
          if (typeof c === "string") return c.trim() === "";
          if (Array.isArray(c)) {
            if (c.length === 0) return true;
            for (const p of c) {
              const part = p as { type?: unknown; content?: unknown; text?: unknown; storageKey?: unknown };
              if (part.type === "image-ref" || part.type === "image") return false;
              if (typeof part.content === "string" && part.content.trim() !== "") return false;
              if (typeof part.text === "string" && part.text.trim() !== "") return false;
            }
            return true;
          }
          return false;
        };
        const DEFAULT_FRESH_USER_CONTENT = "Generate based on document context.";
        let effectiveUserContent: string | unknown[] = ctx.userContent;
        if (!ctx.skipUserEntry && isEmptyUserContent(ctx.userContent as string | unknown[]) && ctx.history.length === 0) {
          effectiveUserContent = Array.isArray(ctx.userContent) ? [{ type: "text", content: DEFAULT_FRESH_USER_CONTENT }] : DEFAULT_FRESH_USER_CONTENT;
        }
        const userEntry = { role: "user", content: effectiveUserContent, ts: ctx.userTs };
        const userEntries = ctx.skipUserEntry || isEmptyUserContent(effectiveUserContent as string | unknown[]) ? [] : [userEntry];
        const toolCallsLog: Array<{ name: string; detail?: string }> = [];
        const writeToolCallIds: string[] = [];
        let writeQueueDrained = false;
        const drainWrites = (): QueuedProposal[] => {
          if (writeQueueDrained || !ctx.writeDrain) return [];
          writeQueueDrained = true;
          return ctx.writeDrain();
        };
        const persistTerminalTurn = async (extra: Record<string, unknown>) => {
          await ctx.persist([...ctx.history, ...userEntries, { role: "assistant", content: stripToolCallXml(text), ts: new Date().toISOString(), ...extra }], ctx.historySummary(), ctx.historySummarizedCount());
        };
        const suspendTurn = async (drained: QueuedProposal[]) => {
          for (const p of drained) {
            push({ type: "tool_pending", approvalId: p.approvalId, batchId: p.batchId, seq: p.seq, name: p.name, ...(p.detail !== undefined ? { detail: p.detail } : {}), diff: p.diff });
          }
          const citations = ctx.getCitations();
          await ctx.persist([...ctx.history, ...userEntries, { role: "assistant", content: stripToolCallXml(text), ts: new Date().toISOString(), ...(citations.length > 0 ? { citations } : {}), ...(toolCallsLog.length > 0 ? { toolCalls: toolCallsLog } : {}), pendingBatch: { batchId: drained[0]!.batchId, approvals: drained.map((p, i) => ({ approvalId: p.approvalId, toolCallId: writeToolCallIds[i] ?? "" })) } }], ctx.historySummary(), ctx.historySummarizedCount());
          push({ type: "suspended", batchId: drained[0]!.batchId });
        };
        try {
          push({ type: "start", [ctx.idField]: ctx.keyId, threadId: ctx.threadId } as StreamFrame);
          for (const r of ctx.approvalResults ?? []) push({ type: "approval_result", approvalId: r.approvalId, status: r.status, ...(r.error !== undefined ? { error: r.error } : {}) });
          const { streamChat } = await import("./provider");
          const prepared = ctx.imageMode === "delegate" ? await replaceImageRefsWithPlaceholders([...ctx.history, ...userEntries]) : await hydrateImageParts([...ctx.history, ...userEntries], ctx.loadImageBase64);
          let toolRounds = 0;
          let didFinish = false;
          const pendingCalls = new Map<string, { name: string; args: string }>();
          const toolNamesById = new Map<string, string>();
          const getStream = (tools: ReadonlyArray<unknown> | undefined): AsyncIterable<StreamChunk> =>
            ctx.gatewayStream ? ctx.gatewayStream({ systemPrompts: ctx.systemPrompts, messages: prepared, tools, abortController: abort, sessionId: ctx.threadId, ...(ctx.modelOptions !== undefined ? { modelOptions: ctx.modelOptions } : {}) }) : streamChat({ config: ctx.config, systemPrompts: ctx.systemPrompts, messages: prepared, tools, abortController: abort, sessionId: ctx.threadId, ...(ctx.modelOptions !== undefined ? { modelOptions: ctx.modelOptions } : {}) });
          const consume = async (tools: ReadonlyArray<unknown> | undefined) => {
            const chunks = getStream(tools);
            const iterator = chunks[Symbol.asyncIterator]();
            for (;;) {
              const next = iterator.next();
              next.catch(() => {});
              let result: IteratorResult<StreamChunk>;
              let stallTimer: ReturnType<typeof setTimeout> | undefined;
              try {
                result = await Promise.race([next, new Promise<never>((_, reject) => { stallTimer = setTimeout(() => { stalled = true; abort.abort(); reject(new HeraldGenerationFailed({ message: STREAM_STALL_MESSAGE })); }, STREAM_STALL_TIMEOUT_MS); })]);
              } finally { clearTimeout(stallTimer); }
              if (result.done) break;
              const chunk = result.value;
              if (chunk.type === "TEXT_MESSAGE_CONTENT") {
                let delta: string = chunk.delta;
                if ((text + delta).search(/<tool_call>/i) !== -1 || delta.search(/<\/tool_call>/i) !== -1) {
                  const combined = text + delta;
                  const cleanedCombined = stripToolCallXmlRaw(combined);
                  const prefixCleaned = stripToolCallXmlRaw(text);
                  delta = cleanedCombined.slice(prefixCleaned.length);
                  text = cleanedCombined;
                } else text += delta;
                if (delta) push({ type: "delta", text: delta });
              } else if (chunk.type === "REASONING_MESSAGE_CONTENT") push({ type: "reasoning", delta: chunk.delta });
              else if (chunk.type === "TOOL_CALL_START") {
                const id = chunk.toolCallId !== undefined ? String(chunk.toolCallId) : "";
                const startName = chunk.toolCallName ?? chunk.toolName ?? "";
                pendingCalls.set(id, { name: startName, args: "" });
                if (startName) toolNamesById.set(id, startName);
              } else if (chunk.type === "TOOL_CALL_ARGS") {
                const pending = pendingCalls.get(chunk.toolCallId !== undefined ? String(chunk.toolCallId) : "");
                if (pending) { const piece = typeof chunk.args === "string" ? chunk.args : typeof chunk.delta === "string" ? chunk.delta : ""; pending.args += piece; }
              } else if (chunk.type === "TOOL_CALL_END") {
                const id = chunk.toolCallId !== undefined ? String(chunk.toolCallId) : "";
                const pending = pendingCalls.get(id);
                const rawName = chunk.toolCallName ?? chunk.toolName ?? pending?.name ?? "";
                if (rawName) toolNamesById.set(id, rawName);
                pendingCalls.delete(id);
                const name = rawName;
                const isWrite = isHeraldWriteTool(name);
                const normalizeDueAtNone = (s: string): string => s.replace(/"dueAt"\s*:\s*"None"/g, '"dueAt":null').replace(/"dueAt"\s*:\s*None\b/g, '"dueAt":null');
                const tryParseStrict = (raw: string): unknown | undefined => {
                  const normalized = normalizeDueAtNone(raw);
                  try { return JSON.parse(normalized) as unknown; } catch { return undefined; }
                };
                const tryParseWithSalvage = (raw: string): unknown | undefined => {
                  const normalized = normalizeDueAtNone(raw);
                  try { return JSON.parse(normalized) as unknown; } catch {}
                  let t = normalized.trim();
                  if (t.endsWith(":")) {
                    const strippedDueAt = t.replace(/,\s*"dueAt"\s*:\s*$/, "");
                    if (strippedDueAt !== t) t = strippedDueAt;
                    else {
                      const strippedDueAtNull = t.replace(/,\s*"dueAt"\s*:\s*null\s*,?\s*$/, "");
                      if (strippedDueAtNull !== t) t = strippedDueAtNull;
                      else {
                        const generic = t.replace(/,\s*"[^"]*"\s*:\s*$/, "");
                        if (generic !== t) t = generic;
                        else return undefined;
                      }
                    }
                  }
                  const candidates: string[] = [];
                  if (t.endsWith(",")) candidates.push(`${t.slice(0, -1)}}`);
                  candidates.push(`${t}}`);
                  for (const c of candidates) { try { return JSON.parse(c) as unknown; } catch {} }
                  const strippedTrailingDueAt = normalized.trim().replace(/,\s*"dueAt"\s*:\s*$/, "").replace(/,\s*"dueAt"\s*:\s*null\s*,?\s*$/, "");
                  if (strippedTrailingDueAt !== normalized.trim()) {
                    const tt = strippedTrailingDueAt;
                    const cands: string[] = [];
                    if (tt.endsWith(",")) cands.push(`${tt.slice(0, -1)}}`);
                    cands.push(`${tt}}`);
                    for (const c of cands) { try { return JSON.parse(c) as unknown; } catch {} }
                  }
                  return undefined;
                };
                let streamedArgs: unknown | undefined;
                if (pending && pending.args !== "") {
                  const tTrim = pending.args.trim();
                  const truncatedLike = tTrim.endsWith(":") || tTrim.endsWith(",") || tTrim.endsWith("{") || tTrim.endsWith('"');
                  if (isWrite && truncatedLike) {
                    streamedArgs = tryParseWithSalvage(pending.args);
                  } else {
                    streamedArgs = isWrite ? tryParseStrict(pending.args) : tryParseWithSalvage(pending.args);
                  }
                  if (streamedArgs === undefined && pending.args.trim() !== "") {
                    const t = pending.args.trim();
                    const truncatedLikeInner = t.endsWith(":") || t.endsWith(",") || t.endsWith("{") || t.endsWith('"');
                    if (truncatedLikeInner) {
                      if (isWrite && streamedArgs === undefined) {
                        const salvaged = tryParseWithSalvage(pending.args);
                        if (salvaged !== undefined) streamedArgs = salvaged;
                      }
                      if (streamedArgs === undefined) {
                        toolRounds += 1;
                        if (toolRounds > ctx.toolRoundCap) { abort.abort(); throw new HeraldToolBudgetExceeded({ rounds: ctx.toolRoundCap }); }
                        push({ type: "error", code: "HERALD_TOOL_ARGS_INVALID", message: `Tool arguments truncated, skipping ${name || "tool"}` });
                        continue;
                      }
                    }
                    if (isWrite && streamedArgs === undefined) {
                      toolRounds += 1;
                      if (toolRounds > ctx.toolRoundCap) { abort.abort(); throw new HeraldToolBudgetExceeded({ rounds: ctx.toolRoundCap }); }
                      push({ type: "error", code: "HERALD_TOOL_ARGS_INVALID", message: `Tool arguments invalid, skipping ${name || "tool"}` });
                      continue;
                    }
                  }
                }
                let finalArgs: unknown = streamedArgs ?? (chunk.input !== undefined && typeof chunk.input === "object" ? chunk.input : undefined);
                if (finalArgs === undefined) {
                  const raw = pending?.args.trim() ?? "";
                  const isBare = !pending && chunk.input === undefined;
                  const isUnparseableNonTruncated = raw !== "" && streamedArgs === undefined && !(raw.endsWith(":") || raw.endsWith(",") || raw.endsWith("{") || raw.endsWith('"'));
                  if (!isBare && !isUnparseableNonTruncated) {
                    toolRounds += 1;
                    if (toolRounds > ctx.toolRoundCap) { abort.abort(); throw new HeraldToolBudgetExceeded({ rounds: ctx.toolRoundCap }); }
                    push({ type: "error", code: "HERALD_TOOL_ARGS_INVALID", message: `Tool arguments truncated, skipping ${name || "tool"}` });
                    continue;
                  }
                  if (isUnparseableNonTruncated && isWrite) {
                    toolRounds += 1;
                    if (toolRounds > ctx.toolRoundCap) { abort.abort(); throw new HeraldToolBudgetExceeded({ rounds: ctx.toolRoundCap }); }
                    push({ type: "error", code: "HERALD_TOOL_ARGS_INVALID", message: `Tool arguments invalid, skipping ${name || "tool"}` });
                    continue;
                  }
                }
                if (finalArgs !== null && typeof finalArgs === "object") {
                  const rec = finalArgs as Record<string, unknown>;
                  if (Object.keys(rec).length === 0 && !ZERO_ARG_TOOLS.has(name)) {
                    toolRounds += 1;
                    if (toolRounds > ctx.toolRoundCap) { abort.abort(); throw new HeraldToolBudgetExceeded({ rounds: ctx.toolRoundCap }); }
                    push({ type: "error", code: "HERALD_TOOL_ARGS_INVALID", message: `Tool arguments truncated, skipping ${name || "tool"}` });
                    continue;
                  }
                  if ("limit" in rec) { const raw = rec.limit; const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN; rec.limit = Number.isFinite(n) && Number.isInteger(n) && n >= 1 && n <= 10 ? n : 10; }
                  if ("dueAt" in rec && rec.dueAt === "None") rec.dueAt = null;
                }
                toolRounds += 1;
                let detail: string | undefined;
                if (finalArgs !== undefined) { try { detail = toolCallDetail(name, finalArgs); } catch { detail = undefined; } }
                if (shouldEmitToolFrame(name)) {
                  push(detail === undefined ? { type: "tool", phase: "call", name } : { type: "tool", phase: "call", name, detail });
                  push(detail === undefined ? { type: "tool", phase: "result", name } : { type: "tool", phase: "result", name, detail });
                  toolCallsLog.push(detail === undefined ? { name } : { name, detail });
                }
                if (toolRounds > ctx.toolRoundCap) { abort.abort(); throw new HeraldToolBudgetExceeded({ rounds: ctx.toolRoundCap }); }
              } else if (chunk.type === "TOOL_CALL_RESULT") {
                const id = chunk.toolCallId !== undefined ? String(chunk.toolCallId) : "";
                const toolName = pendingCalls.get(id)?.name ?? toolNamesById.get(id) ?? (chunk as unknown as { toolCallName?: string; toolName?: string }).toolCallName ?? (chunk as unknown as { toolCallName?: string; toolName?: string }).toolName ?? "";
                if (isHeraldWriteTool(toolName)) { writeToolCallIds.push(id); if (!abort.signal.aborted) abort.abort(); }
              } else if (chunk.type === "RUN_FINISHED") {
                didFinish = true;
                const u = chunk.usage as { input?: number; output?: number; promptTokens?: number; completionTokens?: number } | undefined;
                usageIn = Number(u?.input ?? u?.promptTokens ?? usageIn);
                usageOut = Number(u?.output ?? u?.completionTokens ?? usageOut);
              } else if (chunk.type === "RUN_ERROR") {
                try {
                  const line = JSON.stringify({ level: "ERROR", service: "herald-build-stream", message: `herald RUN_ERROR chunk before translate: ${String(chunk.message).slice(0, 500)}`, meta: { threadId: ctx.threadId, keyId: ctx.keyId, code: (chunk as unknown as { code?: unknown }).code ?? null, rawEvent: (chunk as unknown as { rawEvent?: unknown }).rawEvent ?? null }, timestamp: new Date().toISOString() });
                  process.stderr.write(line + "\n");
                } catch {}
                const err: Record<string, unknown> = { message: chunk.message };
                const c = chunk as unknown as Record<string, unknown>;
                if (c.code !== undefined) { err.code = c.code; err.status = c.code; }
                if (c.rawEvent !== undefined) { err.rawEvent = c.rawEvent; err.error = c.rawEvent; }
                const nested = c.error as Record<string, unknown> | undefined;
                if (nested !== undefined && err.rawEvent === undefined) err.error = nested;
                const e = Object.assign(new Error(chunk.message), err);
                if (c.rawEvent !== undefined) (e as unknown as Record<string, unknown>).cause = c.rawEvent;
                throw translateRunError(e);
              }
            }
          };
          await consume(ctx.tools);
          let drained = drainWrites();
          if (drained.length === 0 && stripToolCallXml(text) === "" && ctx.tools && ctx.tools.length > 0) { await consume(undefined); drained = drainWrites(); }
          text = stripToolCallXml(text);
          {
            const hasWriteTools = ctx.writeTools !== undefined ? ctx.writeTools.length > 0 : !!ctx.writeDrain;
            if (hasWriteTools && drained.length === 0) {
              const userText = extractUserText(ctx.userContent as string | unknown[]);
              const hallucinated = HALLUCINATION_RE.test(text);
              const writeIntent = WRITE_INTENT_RE.test(userText);
              if (hallucinated || writeIntent) {
                const prev = text.slice(0, 500);
                if (writeIntent && /milestone/i.test(userText)) {
                  text = "Maaf, saya belum memanggil tool create_milestone. Silakan coba lagi atau periksa write_tools.";
                } else if (writeIntent) {
                  text = "Maaf, saya belum memanggil tool yang diminta. Silakan coba lagi atau periksa write_tools.";
                } else {
                  text = "I haven't created it yet — the write is gated by approval. I'll propose the creation now; please approve to proceed.";
                }
                const reason = hallucinated ? "hallucinated success without tool call" : "write intent without tool call";
                try {
                  const line = JSON.stringify({
                    level: "WARN",
                    service: "herald-build-stream",
                    message: `HERALD_WRITE_HALLUCINATION_GUARD — ${reason}`,
                    meta: {
                      threadId: ctx.threadId,
                      writeTools: ctx.writeTools ?? null,
                      drained: drained.length,
                      userText: userText.slice(0, 300),
                      prevText: prev.slice(0, 300),
                      replacement: text.slice(0, 300),
                    },
                    timestamp: new Date().toISOString(),
                  });
                  process.stderr.write(line + "\n");
                } catch {}
                push({
                  type: "error",
                  code: "HERALD_WRITE_HALLUCINATION_GUARD",
                  message: `Replaced ${reason}; write tool not called`,
                });
              } else {
                try {
                  const line = JSON.stringify({
                    level: "INFO",
                    service: "herald-build-stream",
                    message: "write tools offered but no tool called",
                    meta: {
                      threadId: ctx.threadId,
                      writeTools: ctx.writeTools ?? null,
                      drained: drained.length,
                      userText: userText.slice(0, 300),
                      text: text.slice(0, 300),
                    },
                    timestamp: new Date().toISOString(),
                  });
                  process.stdout.write(line + "\n");
                } catch {}
              }
            }
          }
          if (drained.length > 0) { await suspendTurn(drained); return; }
          if (!didFinish && !stalled) {
            const code = "HERALD_GENERATION_FAILED";
            const message = STREAM_STALL_MESSAGE;
            const citationsErr = ctx.getCitations();
            const extra: Record<string, unknown> = { error: { code, message } };
            if (citationsErr.length > 0) extra.citations = citationsErr;
            if (toolCallsLog.length > 0) extra.toolCalls = toolCallsLog;
            await persistTerminalTurn(extra).catch(() => {});
            await ctx.onFail(message).catch(() => {});
            push({ type: "error", code, message });
            return;
          }
          if (stalled && drained.length > 0) { await suspendTurn(drained); return; }
          const citations = ctx.getCitations();
          const finalMessages = [...ctx.history, ...userEntries, { role: "assistant", content: text, ts: new Date().toISOString(), ...(citations.length > 0 ? { citations } : {}) }];
          let summary = ctx.historySummary();
          let summarizedCount = ctx.historySummarizedCount();
          let kept = finalMessages;
          if (needsSummary(finalMessages) && findPendingBatch(finalMessages) === null) {
            const olderCandidates = finalMessages.slice(0, finalMessages.length - 8);
            const older = olderCandidates.filter((m) => pendingBatchIdOf((m as { pendingBatch?: unknown } | null)?.pendingBatch) === null);
            if (older.length > 0 && older.length === olderCandidates.length) {
              const condensed = await summarizeOlder(ctx.config, older, ctx.threadId).catch(() => null);
              if (condensed !== null) { summarizedCount += older.length; summary = condensed; kept = finalMessages.slice(-8); }
            }
          }
          await ctx.persist(kept, summary, summarizedCount);
          await ctx.onDone(text);
          push({ type: "done", [ctx.idField]: ctx.keyId, text, usage: { in: usageIn, out: usageOut } } as StreamFrame);
        } catch (e) {
          const drained = drainWrites();
          if (drained.length > 0) {
            await suspendTurn(drained).catch(async () => { await persistTerminalTurn({ stopped: true }).catch(() => {}); await ctx.onCancel().catch(() => {}); });
          } else if (e instanceof HeraldToolBudgetExceeded) {
            await persistTerminalTurn({ error: { code: "HERALD_TOOL_BUDGET_EXCEEDED", message: `Herald exceeded its tool budget (${e.rounds} rounds)` } }).catch(() => {});
            await ctx.onFail(`Herald exceeded its tool budget (${e.rounds} rounds)`).catch(() => {});
            push({ type: "error", code: "HERALD_TOOL_BUDGET_EXCEEDED", message: `Herald exceeded its tool budget (${e.rounds} rounds)` });
          } else if (abort.signal.aborted && !stalled) {
            if (stripToolCallXml(text) !== "") await persistTerminalTurn({ stopped: true }).catch(() => {});
            await ctx.onCancel().catch(() => {});
          } else {
            const err = translateRunError(e);
            const { errorCodeMap } = await import("../api/errors");
            const code = (errorCodeMap as Record<string, string>)[(err as { _tag: string })._tag] ?? "HERALD_GENERATION_FAILED";
            const message = String((err as { message?: string }).message ?? "Herald generation failed");
            const isFatal = code === "HERALD_GENERATION_FAILED" && (message.toLowerCase().includes("upstream response mapping failed") || message.includes("400") || message.includes("422"));
            const level = isFatal ? "FATAL" : "ERROR";
            try {
              const line = JSON.stringify({ level, service: "herald-build-stream", message: `[${(err as { _tag?: string })._tag ?? "HeraldGenerationFailed"}] ${message}`, meta: { threadId: ctx.threadId, keyId: ctx.keyId, idField: ctx.idField, code, errorTag: (err as { _tag?: string })._tag ?? null, status: (err as { status?: unknown }).status ?? null, providerMessage: (err as { providerMessage?: unknown }).providerMessage ?? null }, timestamp: new Date().toISOString() });
              if (level === "FATAL" || level === "ERROR") process.stderr.write(line + "\n");
              else process.stdout.write(line + "\n");
            } catch {}
            await persistTerminalTurn({ error: { code, message } }).catch(() => {});
            await ctx.onFail(String((err as { message?: string }).message ?? "").slice(0, 2000)).catch(() => {});
            push({ type: "error", code, message });
          }
        } finally {
          if (ctx.registry.get(ctx.keyId) === abort) ctx.registry.delete(ctx.keyId);
          closed = true;
          try { controller.close(); } catch {}
        }
      })();
    },
    cancel() { const abort = ctx.registry.get(ctx.keyId); abort?.abort(); },
  });
}
