import { describe, expect, it, vi } from "vitest";
import type { ToolExecutionContext } from "@tanstack/ai";
import { withToolTimeout } from "./tool-caps";
import { buildAssistantWriteTools, buildTaskCreateDiff, buildWikiEditDiff, createLocalWriteTracker, createWriteRecorder } from "./write-tools";

// Criterion: the approval-display contract (docs/LAYERS.md → write tools, "the
// diff is what the approver sees"). A wiki page longer than the old 2,000-char
// preview cap must arrive at the approval card whole on both sides — the card
// scrolls it rather than cutting it. Regression guard for the owner report that
// a long page's proposal was shown truncated.


describe("withToolTimeout (M5 per-call ceiling)", () => {
  it("rejects a call that outlives the ceiling", async () => {
    vi.useFakeTimers();
    try {
      const slow = withToolTimeout(
        { name: "read_wiki_page", execute: () => new Promise<{ ok: boolean }>((resolve) => setTimeout(() => resolve({ ok: true }), 5000)) },
        20
      );
      const timedOut = expect(slow.execute()).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(50);
      await timedOut;
    } finally {
      vi.useRealTimers();
    }
  });
});
describe("write mutation cancellation", () => {
  it("tracks actual recorder insertion and refuses writes after captured SDK cancellation", async () => {
    const tracker = createLocalWriteTracker();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let insertCount = 0;
    const recorder = createWriteRecorder(
      { projectId: "p", documentType: "chat", documentId: "c", ownerUserId: "u" },
      async () => { insertCount += 1; started.resolve(); await release.promise; }
    );
    const tools = buildAssistantWriteTools({
      projectId: "p",
      localWriteTracker: tracker,
      findTaskByRef: async () => null,
      findColumn: async () => null,
      findWikiPageBySlug: async () => null,
      findMilestone: async () => null,
      countSprints: async () => 0,
      findSwimlane: async () => null,
      record: (proposal) => recorder.record(proposal),
    });
    const tool = tools.find((candidate) => candidate.name === "create_task") as unknown as {
      execute(args: unknown, context: ToolExecutionContext): Promise<unknown>;
    };
    const controller = new AbortController();
    const context: ToolExecutionContext = {
      toolCallId: "call-1",
      abortSignal: controller.signal,
      emitCustomEvent: () => {},
    };
    const running = tool.execute({ title: "Late task" }, context);
    await started.promise;
    controller.abort();
    const quiescence = tracker.quiesce();
    let settled = false;
    void quiescence.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    const afterStop = await tool.execute(
      { title: "Must not insert" },
      { ...context, toolCallId: "call-2" }
    );
    expect(afterStop).toMatchObject({ proposed: false });
    expect(insertCount).toBe(1);

    release.resolve();
    expect(await running).toMatchObject({ proposed: true });
    expect(await quiescence).toMatchObject([{ toolCallId: "call-1", toolName: "create_task" }]);
    expect(recorder.drain()).toHaveLength(1);
  });
});

describe("write approval document fidelity", () => {
  it("carries full wiki and task descriptions beyond the preview cap", () => {
    const before = `# ${"b".repeat(2500)}`;
    const after = `## ${"a".repeat(2600)}\n\n**formatting stays in source**`;
    const diff = buildWikiEditDiff({ slug: "intro", title: "Intro", text: before }, { title: "Intro v2", content: after });
    expect(diff.beforeText).toBe(before);
    expect(diff.afterText).toBe(after);
    expect(buildTaskCreateDiff({ title: "Task", description: after }).fields.description).toBe(after);
  });

  it("keeps empty Markdown source empty", () => {
    const diff = buildWikiEditDiff({ slug: "intro", title: "Intro", text: "" }, { content: "" });
    expect(diff.afterText).toBe("");
  });
});
