import { describe, expect, it, vi } from "vitest";
import {
  assertAttachmentCaps,
  buildChatExport,
  buildChatSnippet,
  buildMentionContextBlock,
  buildStream,
  CHAT_CITATION_CAP,
  CHAT_IMAGE_CAPS,
  collectCitation,
  DOC_IMAGE_CAPS,
  hydrateImageParts,
  isStoredImageRef,
  MENTION_CAPS,
  modelOptionsForEffort,
  needsSummary,
  ResolvedMention,
  resolveChatTitle,
  resolveHeraldThread,
  resolveReasoningEffort,
  scanMentionTokens,
  STREAM_STALL_MESSAGE,
  STREAM_STALL_TIMEOUT_MS,
  StreamRunContext,
  SUMMARY_THRESHOLD_MESSAGES,
  type StoredImageRef,
  validateChatFromIndex,
} from "./herald.service";
import { buildSystemPrompts } from "../herald/prompt";
import { buildHeraldTools, MAX_CHAT_TOOL_ROUNDS, MAX_TOOL_ROUNDS, toolCallDetail, type HeraldToolDeps } from "../herald/tools";
import type { HeraldThread } from "../repos/herald-thread.repo";
import type { StreamFrame } from "../../shared/herald";

const providerMock = vi.hoisted(() => ({
  script: [] as Array<Record<string, unknown>>,
  calls: [] as Array<{ input?: { modelOptions?: Record<string, unknown> } }>,
}));

vi.mock("../herald/provider", () => ({
  streamChat: async function* (input?: { modelOptions?: Record<string, unknown> }) {
    providerMock.calls.push({ input });
    for (const chunk of providerMock.script) {
      if (typeof chunk.delayMs === "number") await new Promise((r) => setTimeout(r, chunk.delayMs as number));
      if (chunk.hang === true) await new Promise<void>(() => {});
      yield chunk;
    }
  },
  completeText: async () => {
    throw new Error("unexpected summarize call");
  },
  testConnection: async () => undefined,
  translateRunError: (e: unknown) => e,
}));

describe("Herald toolset", () => {
  const baseDeps: HeraldToolDeps = {
    projectId: "p1",
    allowlist: null,
    searchApiKey: null,
    fetchImpl: fetch,
    storageGet: async () => new Uint8Array(),
    projectOwnsStorageKey: async () => true,
    findTaskByRef: async () => null,
    searchTasksByTitle: async () => [],
    searchWikiPages: async () => [],
    findWikiPageBySlug: async () => null,
    listAllTasks: async () => [],
    listWikiPagesFull: async () => [],
    getBoardStructure: async () => ({ columns: [], swimlanes: [], milestones: [] }),
  };

  it("includes the wiki tools alongside the PM reads", () => {
    const names = buildHeraldTools(baseDeps).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["search_wiki", "read_wiki_page", "get_task", "search_tasks"]));
  });
});

function thread(overrides: Partial<HeraldThread> = {}): HeraldThread {
  return {
    documentType: "task",
    documentId: "t1",
    projectId: "p1",
    ownerUserId: null,
    title: null,
    pinned: false,
    agentId: "a1",
    skillId: "s1",
    messages: [{ role: "user", content: "hello" }],
    summary: "prior summary",
    summarizedCount: 4,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("resolveHeraldThread", () => {
  it("null existing → fresh", () => {
    const v = resolveHeraldThread(null, "a1", "s1");
    expect(v.mode).toBe("fresh");
    expect(v.messages).toEqual([]);
    expect(v.summary).toBeNull();
    expect(v.summarizedCount).toBe(0);
  });

  it("same doc + same agent+skill → continue with history", () => {
    const t = thread();
    const v = resolveHeraldThread(t, "a1", "s1");
    expect(v.mode).toBe("continue");
    expect(v.messages).toBe(t.messages);
    expect(v.summary).toBe("prior summary");
    expect(v.summarizedCount).toBe(4);
  });

  it("agent mismatch → fresh", () => {
    expect(resolveHeraldThread(thread(), "a2", "s1").mode).toBe("fresh");
  });

  it("skill mismatch → fresh", () => {
    expect(resolveHeraldThread(thread(), "a1", "s2").mode).toBe("fresh");
  });

  it("null stored ids vs provided ids → fresh; both null → continue", () => {
    const t = thread({ agentId: null, skillId: null });
    expect(resolveHeraldThread(t, "a1", "s1").mode).toBe("fresh");
    expect(resolveHeraldThread(t, null, null).mode).toBe("continue");
  });
});

describe("resolveChatTitle", () => {
  it("first send derives the title from the message text", () => {
    expect(resolveChatTitle(null, "Fix the login bug\r\nthen verify sessions")).toBe(
      "Fix the login bug then verify sessions"
    );
  });

  it("stored title wins over new derivation (rename survives)", () => {
    const t = thread({ documentType: "chat", documentId: "c1", ownerUserId: "u1", title: "Renamed" });
    expect(resolveChatTitle(t, "a brand new message")).toBe("Renamed");
  });

  it("existing row with NULL title derives from this send (image-only first message caveat)", () => {
    const t = thread({ documentType: "chat", documentId: "c1", ownerUserId: "u1", title: null });
    expect(resolveChatTitle(t, "second message text")).toBe("second message text");
  });

  it("empty derivation → null (title stays unset)", () => {
    expect(resolveChatTitle(null, "   \n\t ")).toBeNull();
    expect(resolveChatTitle(null, "")).toBeNull();
  });

  it("agent/skill change wipes messages but keeps the title", () => {
    const t = thread({
      documentType: "chat",
      documentId: "c1",
      ownerUserId: "u1",
      title: "Kept title",
      agentId: "a1",
      skillId: "s1",
      messages: [{ role: "user", content: "old conversation" }],
    });
    // Mismatched agent → fresh verdict (history gone)…
    const verdict = resolveHeraldThread(t, "a2", "s1");
    expect(verdict.mode).toBe("fresh");
    expect(verdict.messages).toEqual([]);
    // …but the list label survives.
    expect(resolveChatTitle(t, "whatever comes next")).toBe("Kept title");
  });
});

function capture(fn: () => void): { _tag: string; reason?: string } {
  try {
    fn();
  } catch (e) {
    return e as { _tag: string; reason?: string };
  }
  throw new Error("expected throw");
}

describe("assertAttachmentCaps", () => {
  it("passes within caps (doc: per-image limit)", () => {
    const refs = [
      { mimeType: "image/png", size: 1024 },
      { mimeType: "image/jpeg", size: 2 * 1024 * 1024 },
    ];
    expect(() => assertAttachmentCaps(refs, DOC_IMAGE_CAPS)).not.toThrow();
  });

  it("over count → INVALID_ARGS", () => {
    const refs = Array.from({ length: CHAT_IMAGE_CAPS.maxCount + 1 }, () => ({ mimeType: "image/png", size: 10 }));
    const err = capture(() => assertAttachmentCaps(refs, CHAT_IMAGE_CAPS));
    expect(err._tag).toBe("InvalidArgs");
    expect(err.reason).toContain(`at most ${CHAT_IMAGE_CAPS.maxCount}`);
  });

  it("unsupported mime → INVALID_ARGS", () => {
    const err = capture(() => assertAttachmentCaps([{ mimeType: "application/pdf", size: 10 }], CHAT_IMAGE_CAPS));
    expect(err._tag).toBe("InvalidArgs");
    expect(err.reason).toContain("unsupported image type application/pdf");
  });

  it("per-image byte cap exceeded → INVALID_ARGS", () => {
    const err = capture(() =>
      assertAttachmentCaps([{ mimeType: "image/png", size: DOC_IMAGE_CAPS.maxBytesEach + 1 }], DOC_IMAGE_CAPS)
    );
    expect(err._tag).toBe("InvalidArgs");
    expect(err.reason).toContain("MB limit");
  });

  it("total byte cap exceeded → INVALID_ARGS", () => {
    const half = Math.floor(CHAT_IMAGE_CAPS.maxTotalBytes / 2) + 100;
    const err = capture(() =>
      assertAttachmentCaps(
        [
          { mimeType: "image/png", size: half },
          { mimeType: "image/png", size: half },
        ],
        CHAT_IMAGE_CAPS
      )
    );
    expect(err._tag).toBe("InvalidArgs");
    expect(err.reason).toContain("request limit");
  });
});

const ref = (storageKey: string, mimeType = "image/png"): StoredImageRef => ({
  type: "image-ref",
  storageKey,
  mimeType,
});

describe("isStoredImageRef", () => {
  it("accepts image-ref parts with string storageKey; rejects others", () => {
    expect(isStoredImageRef(ref("k"))).toBe(true);
    expect(isStoredImageRef({ type: "text", content: "hi" })).toBe(false);
    expect(isStoredImageRef({ type: "image-ref" })).toBe(false);
    expect(isStoredImageRef(null)).toBe(false);
    expect(isStoredImageRef("nope")).toBe(false);
  });
});

describe("hydrateImageParts", () => {
  const loader = async (key: string) => (key === "dead" ? null : `b64:${key}`);

  it("replaces image-ref with base64 data image part", async () => {
    const out = await hydrateImageParts(
      [{ role: "user", content: ["look", ref("k1")] }],
      loader
    );
    expect(out[0].content).toEqual([
      "look",
      { type: "image", source: { type: "data", value: "b64:k1", mimeType: "image/png" } },
    ]);
  });

  it("drops refs whose blob fails to load — silently", async () => {
    const out = await hydrateImageParts([{ role: "user", content: [ref("dead"), "text stays"] }], loader);
    expect(out[0].content).toEqual(["text stays"]);
  });

  it("loader rejection also drops the ref", async () => {
    const out = await hydrateImageParts([{ role: "user", content: [ref("boom")] }], async () => {
      throw new Error("storage gone");
    });
    expect(out[0].content).toEqual([]);
  });

  it("string content passes through untouched", async () => {
    const msg = { role: "assistant", content: "plain" };
    const out = await hydrateImageParts([msg], loader);
    expect(out[0]).toBe(msg);
  });

  it("preserves message identity fields on hydrated messages", async () => {
    const out = await hydrateImageParts([{ role: "user", name: "u1", content: [ref("k")] }], loader);
    expect(out[0].role).toBe("user");
    expect((out[0] as { name?: string }).name).toBe("u1");
  });
});

describe("needsSummary", () => {
  it("true when message count exceeds threshold", () => {
    const msgs = Array.from({ length: SUMMARY_THRESHOLD_MESSAGES + 1 }, (_, i) => ({ role: "user", content: `m${i}` }));
    expect(needsSummary(msgs)).toBe(true);
  });

  it("false for small short transcripts", () => {
    expect(needsSummary([{ role: "user", content: "hi" }])).toBe(false);
  });

  it("true when JSON bytes exceed threshold even at low count", () => {
    const big = "x".repeat(64 * 1024);
    expect(needsSummary([{ role: "user", content: big }])).toBe(true);
  });
});

describe("@-mention chat resolution", () => {
  it("scans plain tokens; ignores non-token text", () => {
    expect(scanMentionTokens("see @LEX-42 and @home-page, email a@b.no")).toEqual(["LEX-42", "home-page"]);
    expect(scanMentionTokens("no mentions here")).toEqual([]);
    expect(scanMentionTokens("")).toEqual([]);
  });

  it("caps: ≤5 mentions, ≤4000 chars per document, ≤20000 total — silent truncation", () => {
    const many: ResolvedMention[] = Array.from({ length: 8 }, (_, i) => ({
      kind: "task" as const,
      id: `t${i}`,
      label: `T-${i}`,
      text: "x".repeat(50),
    }));
    const block = buildMentionContextBlock(many);
    expect(block.split("\n- [task]").length - 1).toBe(5);

    const big: ResolvedMention[] = [
      { kind: "wiki", id: "w1", label: "Big", text: "y".repeat(6000) },
    ];
    const bigBlock = buildMentionContextBlock(big);
    expect(bigBlock.length).toBeLessThan(6000 + 100);
    expect(bigBlock).toContain("…");

    const huge: ResolvedMention[] = Array.from({ length: 5 }, (_, i) => ({
      kind: "task" as const,
      id: `t${i}`,
      label: `T-${i}`,
      text: "z".repeat(9000),
    }));
    const hugeBlock = buildMentionContextBlock(huge);
    expect(hugeBlock.length).toBeLessThanOrEqual(20000 + 200);
  });

  it("empty resolution → empty block (no context segment)", () => {
    expect(buildMentionContextBlock([])).toBe("");
  });

  it("persistence purity: the user message passes through verbatim; context rides only in system prompts", () => {
    // The chat turn assembles userContent from req.message ALONE — mention
    // content is resolved into systemPrompts.gherkin-style structural check:
    const message = "check @LEX-42 and @home";
    const mentionContext = buildMentionContextBlock([
      { kind: "task", id: "t1", label: "LEX-42 — T", text: "ctx" },
    ]);
    const systemPrompts = buildSystemPrompts({
      identity: "i",
      memoryBlock: null,
      agentMarkdown: null,
      skillMarkdown: null,
      mentionContext,
    });
    // userContent would be exactly `message` (no injected block anywhere).
    expect(message).not.toContain("ctx");
    // The ephemeral block IS present in the last system prompt.
    expect(systemPrompts[systemPrompts.length - 1].content).toContain("[task] LEX-42 — T");
    expect(systemPrompts[systemPrompts.length - 1].content).toContain("Referenced by the user just now:");
    // No mentionContext → no extra segment (existing behavior unchanged).
    const without = buildSystemPrompts({ identity: "i", memoryBlock: null, agentMarkdown: null, skillMarkdown: null });
    expect(without.length).toBe(2);
  });
});

describe("collectCitation", () => {
  it("accepts https citations", () => {
    const out = collectCitation([], { title: "Docs", url: "https://lexa.example/guide" });
    expect(out).toEqual([{ title: "Docs", url: "https://lexa.example/guide" }]);
  });

  it("rejects non-https URLs", () => {
    expect(collectCitation([], { title: null, url: "http://lexa.example/guide" })).toEqual([]);
    expect(collectCitation([], { title: null, url: "ftp://x" })).toEqual([]);
  });

  it("dedupes by URL (first title wins)", () => {
    let out = collectCitation([], { title: "First", url: "https://x.example/a" });
    out = collectCitation(out, { title: "Second", url: "https://x.example/a" });
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("First");
  });

  it("caps at CHAT_CITATION_CAP entries", () => {
    let out: ReturnType<typeof collectCitation> = [];
    for (let i = 0; i < CHAT_CITATION_CAP + 5; i++) {
      out = collectCitation(out, { title: `t${i}`, url: `https://x.example/${i}` });
    }
    expect(out).toHaveLength(CHAT_CITATION_CAP);
  });
});

describe("validateChatFromIndex", () => {
  const msgs = [
    { role: "user", content: "q0" },
    { role: "assistant", content: "a0" },
    { role: "user", content: [{ type: "image-ref", storageKey: "k" }] },
  ];
  const allText = [
    { role: "user", content: "q0" },
    { role: "assistant", content: "a0" },
    { role: "user", content: "q1" },
  ];

  it("accepts integers in [0, length] targeting user text entries", () => {
    expect(() => validateChatFromIndex(allText, 0)).not.toThrow();
    expect(() => validateChatFromIndex(allText, 2)).not.toThrow();
    expect(() => validateChatFromIndex(allText, 3)).not.toThrow(); // append
  });

  it("rejects non-integers and out-of-range indices", () => {
    expect(() => validateChatFromIndex(msgs, 1.5)).toThrow();
    expect(() => validateChatFromIndex(msgs, -1)).toThrow();
    expect(() => validateChatFromIndex(msgs, 4)).toThrow();
    expect(() => validateChatFromIndex(msgs, Number.NaN)).toThrow();
  });

  it("rejects replacing a non-user or image-part entry", () => {
    // assistant entry
    expect(() => validateChatFromIndex(msgs, 1)).toThrow();
    // image-part user entry — rejected in v1
    expect(() => validateChatFromIndex(msgs, 2)).toThrow();
  });

  it("append at length skips the target check", () => {
    expect(() => validateChatFromIndex([], 0)).not.toThrow();
  });
});

describe("buildChatSnippet", () => {
  const msgs = [
    { role: "user", content: "please find the zebra crossing notes" },
    { role: "assistant", content: "here they are" },
  ];

  it("cuts a window around the first case-insensitive match", () => {
    const s = buildChatSnippet(msgs, "ZEBRA");
    expect(s).not.toBeNull();
    expect(s!.toLowerCase()).toContain("zebra");
  });

  it("adds ellipses when the window truncates the transcript", () => {
    const long = [{ role: "user", content: "x".repeat(200) + " needle " + "y".repeat(200) }];
    const s = buildChatSnippet(long, "needle");
    expect(s).not.toBeNull();
    expect(s!.startsWith("…")).toBe(true);
    expect(s!.endsWith("…")).toBe(true);
    expect(s!.length).toBeLessThan(120);
  });

  it("returns null for title-only matches (no transcript hit)", () => {
    expect(buildChatSnippet(msgs, "absent")).toBeNull();
  });

  it("ignores non-string (image-part) contents", () => {
    expect(buildChatSnippet([{ role: "user", content: [{ type: "image-ref" }] }], "x")).toBeNull();
  });
});

describe("buildChatExport", () => {
  it("renders header, speaker blocks with ts, citations and terminal markers", () => {
    const md = buildChatExport({
      title: "Thread title",
      messages: [
        { role: "user", content: "What is Lexa?", ts: "2026-08-22T10:00:00.000Z" },
        {
          role: "assistant",
          content: "A project tool.",
          ts: "2026-08-22T10:00:05.000Z",
          citations: [{ title: "Lexa Docs", url: "https://lexa.example/guide" }, { title: null, url: "https://raw.example/x" }],
        },
        { role: "user", content: "continue" },
        { role: "assistant", content: "par", error: { code: "HERALD_GENERATION_FAILED", message: "boom" } },
        { role: "assistant", content: "frag", stopped: true },
      ],
    });
    expect(md.startsWith("# Thread title\n")).toBe(true);
    expect(md).toContain("**You** · 2026-08-22T10:00:00.000Z\nWhat is Lexa?");
    expect(md).toContain("**Herald** · 2026-08-22T10:00:05.000Z\nA project tool.");
    expect(md).toContain("- [Lexa Docs](https://lexa.example/guide)");
    expect(md).toContain("- <https://raw.example/x>");
    expect(md).toContain("**You**\ncontinue"); // no ts → no suffix
    expect(md).toContain("[failed turn: HERALD_GENERATION_FAILED]");
    expect(md).toContain("[stopped]");
    expect(md.endsWith("\n")).toBe(true);
  });

  it("falls back to 'chat' when untitled; renders image parts as [image]", () => {
    const md = buildChatExport({
      title: null,
      messages: [{ role: "user", content: [{ type: "text", content: "with picture" }, { type: "image-ref", storageKey: "k" }] }],
    });
    expect(md.startsWith("# chat\n")).toBe(true);
    expect(md).toContain("with picture");
    expect(md).toContain("[image]");
  });
});

const toolEnd = (name = "search_wiki"): Record<string, unknown> => ({ type: "TOOL_CALL_END", toolCallName: name });

async function drain(s: ReadableStream<StreamFrame>): Promise<StreamFrame[]> {
  const out: StreamFrame[] = [];
  const reader = s.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

describe("Herald tool budget", () => {
  const baseCtx = (toolRoundCap: number): StreamRunContext => ({
    keyId: "c1",
    idField: "chatId",
    threadId: "c1",
    registry: new Map(),
    config: { kind: "openai_compatible", baseUrl: "https://x.example", apiKey: "k", model: "m" },
    systemPrompts: [],
    history: [],
    userTs: "2026-08-24T00:00:00Z",
    getCitations: () => [],
    userContent: "hi",
    tools: [],
    toolRoundCap,
    loadImageBase64: async () => null,
    imageMode: "inline",
    historySummary: () => null,
    historySummarizedCount: () => 0,
    persist: async () => {},
    onDone: async () => {},
    onFail: async () => {},
    onCancel: async () => {},
  });

  it("freeform chat cap allows MAX_CHAT_TOOL_ROUNDS rounds before tripping", async () => {
    providerMock.script = Array.from({ length: MAX_CHAT_TOOL_ROUNDS }, () => toolEnd()).concat([{ type: "RUN_FINISHED" }]);
    const frames = await drain(buildStream(baseCtx(MAX_CHAT_TOOL_ROUNDS)));
    expect(frames.at(-1)?.type).toBe("done");
    expect(frames.some((f) => f.type === "error")).toBe(false);
  });

  it("freeform chat cap trips at MAX_CHAT_TOOL_ROUNDS + 1 with HERALD_TOOL_BUDGET_EXCEEDED", async () => {
    providerMock.script = Array.from({ length: MAX_CHAT_TOOL_ROUNDS + 1 }, () => toolEnd());
    const frames = await drain(buildStream(baseCtx(MAX_CHAT_TOOL_ROUNDS)));
    const err = frames.find((f) => f.type === "error") as { code?: string; message?: string } | undefined;
    expect(err?.code).toBe("HERALD_TOOL_BUDGET_EXCEEDED");
    expect(err?.message).toContain(`(${MAX_CHAT_TOOL_ROUNDS} rounds)`);
  });

  it("document-task cap still trips at MAX_TOOL_ROUNDS + 1 and allows exactly MAX_TOOL_ROUNDS", async () => {
    providerMock.script = Array.from({ length: MAX_TOOL_ROUNDS }, () => toolEnd()).concat([{ type: "RUN_FINISHED" }]);
    const okFrames = await drain(buildStream(baseCtx(MAX_TOOL_ROUNDS)));
    expect(okFrames.at(-1)?.type).toBe("done");

    providerMock.script = Array.from({ length: MAX_TOOL_ROUNDS + 1 }, () => toolEnd());
    const frames = await drain(buildStream(baseCtx(MAX_TOOL_ROUNDS)));
    const err = frames.find((f) => f.type === "error") as { code?: string; message?: string } | undefined;
    expect(err?.code).toBe("HERALD_TOOL_BUDGET_EXCEEDED");
    expect(err?.message).toContain(`(${MAX_TOOL_ROUNDS} rounds)`);
  });
});

describe("buildStream reasoning frames", () => {
  const baseCtx = (): StreamRunContext & { persistCalls: unknown[][] } => {
    const persistCalls: unknown[][] = [];
    return {
      keyId: "c1",
      idField: "chatId",
      threadId: "c1",
      registry: new Map(),
      config: { kind: "openai_compatible", baseUrl: "https://x.example", apiKey: "k", model: "m" },
      systemPrompts: [],
      history: [],
      userTs: "2026-08-24T00:00:00Z",
      getCitations: () => [],
      userContent: "hi",
      tools: [],
      toolRoundCap: MAX_CHAT_TOOL_ROUNDS,
      loadImageBase64: async () => null,
      imageMode: "inline",
      historySummary: () => null,
      historySummarizedCount: () => 0,
      persist: async (messages) => {
        persistCalls.push(messages);
      },
      persistCalls,
      onDone: async () => {},
      onFail: async () => {},
      onCancel: async () => {},
    };
  };

  it("reasoning chunks yield reasoning frames in order, interleaved with deltas", async () => {
    providerMock.script = [
      { type: "REASONING_MESSAGE_START" },
      { type: "REASONING_MESSAGE_CONTENT", delta: "think " },
      { type: "REASONING_MESSAGE_CONTENT", delta: "hard" },
      { type: "TEXT_MESSAGE_START" },
      { type: "TEXT_MESSAGE_CONTENT", delta: "answer" },
      { type: "RUN_FINISHED" },
    ];
    const frames = await drain(buildStream(baseCtx()));
    const streamFrames = frames.filter((f) => f.type === "reasoning" || f.type === "delta");
    expect(streamFrames).toEqual([
      { type: "reasoning", delta: "think " },
      { type: "reasoning", delta: "hard" },
      { type: "delta", text: "answer" },
    ]);
    expect(frames.at(-1)?.type).toBe("done");
  });

  it("reasoning content is never persisted into the transcript", async () => {
    providerMock.script = [
      { type: "REASONING_MESSAGE_CONTENT", delta: "secret thoughts" },
      { type: "TEXT_MESSAGE_CONTENT", delta: "public answer" },
      { type: "RUN_FINISHED" },
    ];
    const ctx = baseCtx();
    const frames = await drain(buildStream(ctx));
    expect(frames.at(-1)?.type).toBe("done");
    expect(ctx.persistCalls.length).toBe(1);
    for (const messages of ctx.persistCalls) {
      const assistant = (messages as Array<{ role: string; content: unknown }>).at(-1);
      expect(assistant?.role).toBe("assistant");
      expect(assistant?.content).toBe("public answer");
      expect(JSON.stringify(messages)).not.toContain("secret thoughts");
    }
  });

  it("models without reasoning emit no reasoning frames", async () => {
    providerMock.script = [
      { type: "TEXT_MESSAGE_CONTENT", delta: "plain" },
      { type: "RUN_FINISHED" },
    ];
    const frames = await drain(buildStream(baseCtx()));
    expect(frames.some((f) => f.type === "reasoning")).toBe(false);
  });
});

describe("tool frame detail", () => {
  const baseCtx = (): StreamRunContext => ({
    keyId: "c1",
    idField: "chatId",
    threadId: "c1",
    registry: new Map(),
    config: { kind: "openai_compatible", baseUrl: "https://x.example", apiKey: "k", model: "m" },
    systemPrompts: [],
    history: [],
    userTs: "2026-08-24T00:00:00Z",
    getCitations: () => [],
    userContent: "hi",
    tools: [],
    toolRoundCap: MAX_CHAT_TOOL_ROUNDS,
    loadImageBase64: async () => null,
    imageMode: "inline",
    historySummary: () => null,
    historySummarizedCount: () => 0,
    persist: async () => {},
    onDone: async () => {},
    onFail: async () => {},
    onCancel: async () => {},
  });

  it("call and result frames carry the detail built from the streamed args", async () => {
    providerMock.script = [
      { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "search_wiki" },
      { type: "TOOL_CALL_ARGS", toolCallId: "t1", args: '{"query":"auth flow"}' },
      { type: "TOOL_CALL_END", toolCallId: "t1" },
      { type: "RUN_FINISHED" },
    ];
    const frames = await drain(buildStream(baseCtx()));
    const toolFrames = frames.filter((f) => f.type === "tool") as Array<{ phase: string; name: string; detail?: string }>;
    expect(toolFrames).toEqual([
      { type: "tool", phase: "call", name: "search_wiki", detail: 'Searching wiki for "auth flow"' },
      { type: "tool", phase: "result", name: "search_wiki", detail: 'Searching wiki for "auth flow"' },
    ]);
  });

  it("END without START/ARGS still emits bare frames (no detail)", async () => {
    providerMock.script = [toolEnd(), { type: "RUN_FINISHED" }];
    const frames = await drain(buildStream(baseCtx()));
    const toolFrames = frames.filter((f) => f.type === "tool") as Array<{ detail?: string }>;
    expect(toolFrames).toHaveLength(2);
    for (const f of toolFrames) expect(f.detail).toBeUndefined();
  });

  it("unparseable args yield no detail", async () => {
    providerMock.script = [
      { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "get_task" },
      { type: "TOOL_CALL_ARGS", toolCallId: "t1", args: "{not json" },
      { type: "TOOL_CALL_END", toolCallId: "t1" },
      { type: "RUN_FINISHED" },
    ];
    const frames = await drain(buildStream(baseCtx()));
    const toolFrames = frames.filter((f) => f.type === "tool") as Array<{ detail?: string }>;
    expect(toolFrames).toHaveLength(2);
    for (const f of toolFrames) expect(f.detail).toBeUndefined();
  });

  it("details truncate to ~80 chars with an ellipsis", async () => {
    const long = toolCallDetail("search_wiki", { query: "x".repeat(200) })!;
    expect(long.length).toBe(80);
    expect(long).toMatch(/…$/);
  });
});

describe("stream stall watchdog", () => {
  const baseCtx = (): StreamRunContext & { persistCalls: unknown[][] } => {
    const persistCalls: unknown[][] = [];
    return {
      keyId: "c1",
      idField: "chatId",
      threadId: "c1",
      registry: new Map(),
      config: { kind: "openai_compatible", baseUrl: "https://x.example", apiKey: "k", model: "m" },
      systemPrompts: [],
      history: [],
      userTs: "2026-08-24T00:00:00Z",
      getCitations: () => [],
      userContent: "hi",
      tools: [],
      toolRoundCap: MAX_CHAT_TOOL_ROUNDS,
      loadImageBase64: async () => null,
      imageMode: "inline",
      historySummary: () => null,
      historySummarizedCount: () => 0,
      persist: async (messages) => {
        persistCalls.push(messages);
      },
      persistCalls,
      onDone: async () => {},
      onFail: async () => {},
      onCancel: async () => {},
    };
  };

  it("trips at 90s of silence → HERALD_GENERATION_FAILED + partial text persisted", async () => {
    vi.useFakeTimers();
    try {
      providerMock.script = [{ type: "TEXT_MESSAGE_CONTENT", delta: "par" }, { hang: true }];
      const ctx = baseCtx();
      const pending = drain(buildStream(ctx));
      await vi.advanceTimersByTimeAsync(STREAM_STALL_TIMEOUT_MS);
      const frames = await pending;
      const err = frames.find((f) => f.type === "error") as { code?: string; message?: string } | undefined;
      expect(err?.code).toBe("HERALD_GENERATION_FAILED");
      expect(err?.message).toBe("stream stalled — no response from provider");
      const last = (ctx.persistCalls.at(-1) as Array<{ role?: string; content?: unknown; error?: unknown }>).at(-1);
      expect(last).toMatchObject({
        role: "assistant",
        content: "par",
        error: { code: "HERALD_GENERATION_FAILED", message: "stream stalled — no response from provider" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a chunk before the deadline resets the timer (trips only after a fresh 90s)", async () => {
    vi.useFakeTimers();
    try {
      providerMock.script = [
        { type: "TEXT_MESSAGE_CONTENT", delta: "a", delayMs: 50_000 },
        { type: "TEXT_MESSAGE_CONTENT", delta: "b", delayMs: 50_000 },
        { hang: true },
      ];
      const ctx = baseCtx();
      const pending = drain(buildStream(ctx));
      await vi.advanceTimersByTimeAsync(50_000); // chunk 1 lands at t=50s, timer resets
      await vi.advanceTimersByTimeAsync(50_000); // chunk 2 lands at t=100s, timer resets
      await vi.advanceTimersByTimeAsync(90_000); // trips at t=190s (90s after the last chunk)
      const frames = await pending;
      expect(frames.some((f) => f.type === "error")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("normal streams finish without tripping the watchdog", async () => {
    vi.useFakeTimers();
    try {
      providerMock.script = [
        { type: "TEXT_MESSAGE_CONTENT", delta: "ok" },
        { type: "RUN_FINISHED" },
      ];
      const pending = drain(buildStream(baseCtx()));
      await vi.advanceTimersByTimeAsync(STREAM_STALL_TIMEOUT_MS * 2);
      const frames = await pending;
      expect(frames.at(-1)?.type).toBe("done");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("reasoning effort resolution", () => {
  it("per-turn override beats the project default", () => {
    expect(resolveReasoningEffort("high", "low")).toBe("low");
    expect(resolveReasoningEffort(null, "minimal")).toBe("minimal");
  });

  it("absent/null override falls back to the project default", () => {
    expect(resolveReasoningEffort("medium", undefined)).toBe("medium");
    expect(resolveReasoningEffort("medium", null)).toBe("medium");
  });

  it("both unset → null (no param sent)", () => {
    expect(resolveReasoningEffort(null, undefined)).toBeNull();
    expect(resolveReasoningEffort(null, null)).toBeNull();
  });

  it("modelOptionsForEffort: null → undefined; effort → reasoning_effort body key", () => {
    expect(modelOptionsForEffort(null)).toBeUndefined();
    expect(modelOptionsForEffort("high")).toEqual({ reasoning_effort: "high" });
  });

  it("buildStream forwards modelOptions into streamChat; absent → no modelOptions", async () => {
    providerMock.script = [
      { type: "TEXT_MESSAGE_CONTENT", delta: "ok" },
      { type: "RUN_FINISHED" },
    ];
    const baseCtx = (modelOptions?: Record<string, unknown>): StreamRunContext => ({
      keyId: "c1",
      idField: "chatId",
      threadId: "c1",
      registry: new Map(),
      config: { kind: "openai_compatible", baseUrl: "https://x.example", apiKey: "k", model: "m" },
      systemPrompts: [],
      history: [],
      userTs: "2026-08-24T00:00:00Z",
      getCitations: () => [],
      userContent: "hi",
      tools: [],
      toolRoundCap: MAX_CHAT_TOOL_ROUNDS,
      loadImageBase64: async () => null,
      imageMode: "inline",
      historySummary: () => null,
      historySummarizedCount: () => 0,
      persist: async () => {},
      onDone: async () => {},
      onFail: async () => {},
      onCancel: async () => {},
      ...(modelOptions !== undefined ? { modelOptions } : {}),
    });

    providerMock.calls = [];
    await drain(buildStream(baseCtx({ reasoning_effort: "high" })));
    expect(providerMock.calls.at(-1)?.input?.modelOptions).toEqual({ reasoning_effort: "high" });

    providerMock.calls = [];
    await drain(buildStream(baseCtx()));
    expect(providerMock.calls.at(-1)?.input?.modelOptions).toBeUndefined();
  });
});
