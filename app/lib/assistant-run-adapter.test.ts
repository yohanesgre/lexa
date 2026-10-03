import { describe, expect, it } from "vitest";
import {
  RUN_LOG_REPLAY_BOUNDARY,
  eventLinesFromParts,
  extractSpawnedRuns,
  formatRunDuration,
  liveStatusToCardState,
  mergeRunCard,
  parseRunTimestamp,
  partToEventLine,
  runBudgetDetail,
  runCardFromLive,
  runCardFromPersisted,
  runElapsedMs,
  runStatusToCardState,
} from "./assistant-run-adapter";
import type { AssistantRunRow } from "../../shared/assistant";

function row(overrides: Partial<AssistantRunRow> = {}): AssistantRunRow {
  return {
    id: "run-1",
    projectId: "p1",
    threadKey: "chat:c1",
    parentRunId: null,
    kind: "chat_run",
    status: "running",
    goal: "Cross-check the rollback section",
    result: null,
    error: null,
    budgetMs: 600_000,
    stepsUsed: 9,
    createdBy: "u1",
    createdAt: "2026-01-01 10:00:00",
    startedAt: "2026-01-01 10:00:01",
    finishedAt: null,
    ...overrides,
  };
}

function toolPart(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "tool-update_wiki",
    toolCallId: "tc1",
    state: "output-available",
    input: {},
    output: { detail: "Added rollback section" },
    ...overrides,
  };
}

describe("run status → card state", () => {
  it("maps the five registry statuses 1:1", () => {
    expect(runStatusToCardState("queued")).toBe("dispatching");
    expect(runStatusToCardState("running")).toBe("running");
    expect(runStatusToCardState("completed")).toBe("done");
    expect(runStatusToCardState("failed")).toBe("failed");
    expect(runStatusToCardState("cancelled")).toBe("stopped");
  });

  it("maps live SDK statuses, treating aborted as stopped", () => {
    expect(liveStatusToCardState("running")).toBe("running");
    expect(liveStatusToCardState("completed")).toBe("done");
    expect(liveStatusToCardState("error")).toBe("failed");
    expect(liveStatusToCardState("interrupted")).toBe("failed");
    expect(liveStatusToCardState("aborted")).toBe("stopped");
  });
});

describe("extractSpawnedRuns", () => {
  it("reads runId + goal from persisted spawn_run tool output", () => {
    const refs = extractSpawnedRuns([
      { role: "assistant", parts: [{ type: "text", text: "spawning" }, toolPart({ type: "tool-spawn_run", input: { goal: "Draft acceptance criteria" }, output: { ok: true, runId: "r1" } })] },
    ]);
    expect(refs).toEqual([{ runId: "r1", goal: "Draft acceptance criteria", toolCallId: "tc1" }]);
  });

  it("ignores refused spawns, non-output parts, and dedupes by runId", () => {
    const refs = extractSpawnedRuns([
      {
        parts: [
          toolPart({ type: "tool-spawn_run", toolCallId: "a", state: "input-available", output: undefined }),
          toolPart({ type: "tool-spawn_run", toolCallId: "b", output: { ok: false, code: "ASSISTANT_RUN_CAP_EXCEEDED" } }),
          toolPart({ type: "tool-spawn_run", toolCallId: "c", input: { goal: "g" }, output: { ok: true, runId: "r1" } }),
          toolPart({ type: "tool-spawn_run", toolCallId: "d", input: { goal: "g" }, output: { ok: true, runId: "r1" } }),
          toolPart({ type: "tool-check_run", output: { ok: true, runId: "r9" } }),
        ],
      },
    ]);
    expect(refs.map((r) => r.runId)).toEqual(["r1"]);
  });
});

describe("event lines + auto-writes", () => {
  it("flags an applied write as auto and keeps its proposal detail", () => {
    expect(partToEventLine(toolPart({ output: { detail: "Tightened checklist", applied: true } }))).toEqual({
      name: "update_wiki",
      text: "Tightened checklist",
      auto: true,
    });
  });

  it("ignores non-tool parts", () => {
    expect(partToEventLine({ type: "text", text: "hi" })).toBeNull();
    expect(partToEventLine(null)).toBeNull();
  });

  // ── Fixtures copied from real tool outputs (server/assistant/tools.ts,
  //    write-tools.ts) — the shapes the adapter previously keyed wrong. ──

  it("summarises a real search_wiki read from its input (wireframe shape)", () => {
    expect(
      partToEventLine({
        type: "tool-search_wiki",
        toolCallId: "tc1",
        state: "output-available",
        input: { query: "cutover-runbook" },
        output: { pages: [{ title: "Cutover runbook", slug: "cutover-runbook", snippet: "…" }] },
      })
    ).toEqual({ name: "search_wiki", text: 'Reading "cutover-runbook"', auto: false });
  });

  it("summarises a real read_repo_file call", () => {
    expect(
      partToEventLine({
        type: "tool-read_repo_file",
        toolCallId: "tc2",
        state: "output-available",
        input: { repo: "lexa/app", path: "scripts/cutover.sh" },
        output: { content: "# cutover", mimeType: "text/plain" },
      })
    ).toEqual({ name: "read_repo_file", text: "Reading scripts/cutover.sh", auto: false });
  });

  it("uses an auto-write result id/key when no proposal detail is carried", () => {
    expect(
      partToEventLine({
        type: "tool-edit_wiki_page",
        toolCallId: "tc3",
        state: "output-available",
        input: { slug: "release-runbook", content: { type: "doc", content: [] } },
        output: { ok: true, applied: true, result: { id: "w1", slug: "release-runbook", title: "Release runbook" } },
      })
    ).toEqual({ name: "edit_wiki_page", text: "release-runbook", auto: true });
  });

  it("carries an ask-mode proposal detail and never flags it auto", () => {
    expect(
      partToEventLine({
        type: "tool-edit_wiki_page",
        toolCallId: "tc4",
        state: "output-available",
        input: { slug: "release-runbook", content: { type: "doc" } },
        output: {
          ok: true,
          proposed: true,
          approvalId: "ap1",
          batchId: "b1",
          seq: 0,
          name: "edit_wiki_page",
          detail: "Added rollback section",
        },
      })
    ).toEqual({ name: "edit_wiki_page", text: "Added rollback section", auto: false });
  });

  it("falls back to a non-empty line for an unknown tool (MCP descriptor)", () => {
    expect(
      partToEventLine({
        type: "tool-mcp__github__create_issue",
        toolCallId: "tc5",
        state: "output-available",
        input: { repo: "lexa/app" },
        output: { content: "created" },
      })
    ).toEqual({ name: "mcp__github__create_issue", text: "created", auto: false });
  });

  it("surfaces a tool error and a write failure", () => {
    expect(
      partToEventLine({
        type: "tool-fetch_url",
        toolCallId: "tc6",
        state: "output-available",
        input: { url: "http://10.0.0.1" },
        output: { content: "", error: "blocked: private address" },
      })
    ).toEqual({ name: "fetch_url", text: "blocked: private address", auto: false });
    expect(
      partToEventLine({
        type: "tool-create_task",
        toolCallId: "tc7",
        state: "output-available",
        input: { title: "Ship it" },
        output: { ok: false, applied: false, error: "TASK_CREATE_FAILED" },
      })
    ).toEqual({ name: "create_task", text: "TASK_CREATE_FAILED", auto: false });
  });

  it("builds a non-empty line for every runner tool call in a batch", () => {
    const lines = [
      {
        type: "tool-get_board_structure",
        toolCallId: "b1",
        state: "output-available",
        input: {},
        output: { columns: [{ id: "c1" }], swimlanes: [], milestones: [] },
      },
      { type: "tool-spawn_run", toolCallId: "b2", state: "input-available", input: {} },
    ];
    for (const line of eventLinesFromParts(lines)) expect(line.text.length).toBeGreaterThan(0);
  });
});

describe("run card models", () => {
  it("persisted-only card carries no live log, no auto-writes, no mode", () => {
    const card = runCardFromPersisted(row({ status: "completed", result: "Done." }));
    expect(card.state).toBe("done");
    expect(card.live).toBe(false);
    expect(card.events).toEqual([]);
    expect(card.autoWrites).toBe(0);
    expect(card.mode).toBeNull();
    expect(card.result).toBe("Done.");
  });

  it("live card carries the event log, auto-write count, and inferred mode", () => {
    const card = runCardFromLive(row(), {
      status: "running",
      parts: [toolPart({ output: { detail: "Reading runbook" } }), toolPart({ output: { detail: "Wrote section", applied: true } })],
    });
    expect(card.live).toBe(true);
    expect(card.state).toBe("running");
    expect(card.events).toHaveLength(2);
    expect(card.autoWrites).toBe(1);
    expect(card.mode).toContain("Auto");
  });

  it("keeps a soft interrupt (child still running) as Running", () => {
    const card = runCardFromLive(row(), { status: "interrupted", childStillRunning: true });
    expect(card.state).toBe("running");
  });

  it("lands a hard interrupt as Failed with the live error", () => {
    const card = runCardFromLive(row(), { status: "interrupted", childStillRunning: false, error: "ASSISTANT_RUN_BUDGET_EXCEEDED" });
    expect(card.state).toBe("failed");
    expect(card.error).toBe("ASSISTANT_RUN_BUDGET_EXCEEDED");
  });

  it("mergeRunCard uses persisted columns without live frames in this tab", () => {
    const persisted = mergeRunCard(row({ status: "completed", result: "Done." }), { status: "completed" }, false);
    expect(persisted.live).toBe(false);
    expect(persisted.result).toBe("Done.");
    const live = mergeRunCard(row(), { status: "running", parts: [toolPart()] }, true);
    expect(live.live).toBe(true);
    expect(live.events).toHaveLength(1);
  });

  it("pins the reload boundary copy verbatim", () => {
    expect(RUN_LOG_REPLAY_BOUNDARY).toBe(
      "Persisted run columns are all that reload returns (status · steps_used · started_at · result/error); the live event log is never replayed."
    );
  });

  it("slices replayed leading parts off the live event log", () => {
    const card = runCardFromLive(
      row(),
      {
        status: "running",
        parts: [
          toolPart({ output: { detail: "replayed read" } }),
          toolPart({ output: { detail: "live read" } }),
          toolPart({ output: { detail: "live write", applied: true } }),
        ],
      },
      1
    );
    expect(card.events.map((line) => line.text)).toEqual(["live read", "live write"]);
    expect(card.autoWrites).toBe(1);
  });

  it("carries the persisted timing + live progress fraction onto the card", () => {
    const live = runCardFromLive(row(), { status: "running", progress: { fraction: 0.56 } });
    expect(live.startedAt).toBe("2026-01-01 10:00:01");
    expect(live.finishedAt).toBeNull();
    expect(live.budgetMs).toBe(600_000);
    expect(live.progressFraction).toBe(0.56);

    const persisted = runCardFromPersisted(row({ status: "completed", result: "Done." }));
    expect(persisted.progressFraction).toBeNull();
    expect(persisted.budgetMs).toBe(600_000);
  });

  it("passes the liveFrom slice through mergeRunCard", () => {
    const card = mergeRunCard(
      row(),
      { status: "running", parts: [toolPart({ output: { detail: "replayed" } }), toolPart({ output: { detail: "live" } })] },
      true,
      1
    );
    expect(card.events.map((line) => line.text)).toEqual(["live"]);
  });
});

describe("run timing + budget copy", () => {
  it("parses SQLite space-form timestamps as UTC", () => {
    expect(parseRunTimestamp("2026-01-01 10:00:00")).toBe(Date.parse("2026-01-01T10:00:00Z"));
    expect(parseRunTimestamp("2026-01-01T10:00:00Z")).toBe(Date.parse("2026-01-01T10:00:00Z"));
    expect(parseRunTimestamp(null)).toBeNull();
    expect(parseRunTimestamp("not-a-date")).toBeNull();
  });

  it("uses finishedAt for terminal runs and now for live runs", () => {
    expect(runElapsedMs("2026-01-01 10:00:00", "2026-01-01 10:00:38", 0)).toBe(38_000);
    expect(runElapsedMs("2026-01-01 10:00:00", null, Date.parse("2026-01-01T10:04:12Z"))).toBe(252_000);
    expect(runElapsedMs(null, null, 0)).toBeNull();
  });

  it("formats compact wireframe-style durations", () => {
    expect(formatRunDuration(38_000)).toBe("38s");
    expect(formatRunDuration(252_000)).toBe("4m 12s");
    expect(formatRunDuration(600_000)).toBe("10m");
    expect(formatRunDuration(3_900_000)).toBe("1h 5m");
  });

  it("builds the drill-in budget row", () => {
    const card = runCardFromPersisted(
      row({ status: "completed", startedAt: "2026-01-01 10:00:00", finishedAt: "2026-01-01 10:00:38", stepsUsed: 16, budgetMs: 600_000 })
    );
    expect(runBudgetDetail(card, 0)).toBe("38s / 10m · 16 / 16 steps");
    const unknown = runCardFromPersisted(row({ startedAt: null, budgetMs: null, stepsUsed: 0 }));
    expect(runBudgetDetail(unknown, 0)).toBe("— / — · 0 / 16 steps");
  });
});
