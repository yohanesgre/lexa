import { describe, expect, it, vi } from "vitest";
import {
  abortDelegatedRun,
  dispatchRegisteredRun,
  isTerminalAgentToolStatus,
  runStatusForTerminal,
  spawnDelegatedRun,
  DEFAULT_RUN_BUDGET_MS,
  MAX_RUN_BUDGET_MS,
  PROJECT_RUN_LIMIT,
  THREAD_RUN_LIMIT,
  type DelegationDeps,
} from "./delegation";
import type { AssistantRunRow } from "../../shared/assistant";

function row(over: Partial<AssistantRunRow> = {}): AssistantRunRow {
  return {
    id: "r1",
    projectId: "p1",
    threadKey: "chat:c1",
    parentRunId: null,
    kind: "chat_run",
    status: "queued",
    goal: "g",
    result: null,
    error: null,
    budgetMs: DEFAULT_RUN_BUDGET_MS,
    stepsUsed: 0,
    createdBy: "u1",
    createdAt: "2026-01-01T00:00:00Z",
    startedAt: null,
    finishedAt: null,
    ...over,
  };
}

function deps(over: Partial<DelegationDeps> = {}): DelegationDeps {
  return {
    dispatcher: {
      dispatch: vi.fn(async () => ({ status: "running" as const })),
      cancel: vi.fn(async () => {}),
    },
    createRun: vi.fn(async (input) => row({ id: input.id, goal: input.goal })),
    updateRun: vi.fn(async () => true),
    getRun: vi.fn(async () => row()),
    counts: vi.fn(async () => ({ thread: 0, project: 0 })),
    ...over,
  };
}

const INPUT = { goal: "do it", projectId: "p1", threadKey: "chat:c1", mode: "ask", createdBy: "u1" };

describe("spawnDelegatedRun", () => {
  it("refuses an empty goal", async () => {
    const d = deps();
    const result = await spawnDelegatedRun(d, { ...INPUT, goal: "   " });
    expect(result).toMatchObject({ ok: false, code: "INVALID_PAYLOAD" });
    expect(d.dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("refuses a budget over the ceiling and a non-positive budget", async () => {
    const d = deps();
    const over = await spawnDelegatedRun(d, { ...INPUT, budgetMs: MAX_RUN_BUDGET_MS + 1 });
    expect(over).toMatchObject({ ok: false, code: "ASSISTANT_RUN_BUDGET_EXCEEDED" });
    const zero = await spawnDelegatedRun(d, { ...INPUT, budgetMs: 0 });
    expect(zero).toMatchObject({ ok: false, code: "ASSISTANT_RUN_BUDGET_EXCEEDED" });
    expect(d.createRun).not.toHaveBeenCalled();
  });

  it("enforces the 1/thread and 3/project caps before creating a row", async () => {
    const thread = deps({ counts: vi.fn(async () => ({ thread: THREAD_RUN_LIMIT, project: 0 })) });
    const t = await spawnDelegatedRun(thread, INPUT);
    expect(t).toMatchObject({ ok: false, code: "ASSISTANT_RUN_CAP_EXCEEDED" });
    expect(thread.createRun).not.toHaveBeenCalled();

    const project = deps({ counts: vi.fn(async () => ({ thread: 0, project: PROJECT_RUN_LIMIT })) });
    const p = await spawnDelegatedRun(project, INPUT);
    expect(p).toMatchObject({ ok: false, code: "ASSISTANT_RUN_CAP_EXCEEDED" });
    expect(project.createRun).not.toHaveBeenCalled();
  });

  it("records the row, dispatches detached, and marks it running", async () => {
    const d = deps();
    const result = await spawnDelegatedRun(d, { ...INPUT, runId: "run-fixed", budgetMs: 5000 });
    expect(result).toEqual({ ok: true, runId: "run-fixed" });
    expect(d.createRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: "run-fixed", kind: "chat_run", goal: "do it", budgetMs: 5000 })
    );
    expect(d.dispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-fixed", budgetMs: 5000, mode: "ask" })
    );
    expect(d.updateRun).toHaveBeenCalledWith({ runId: "run-fixed", status: "running" });
  });

  it("defaults the budget and marks a rejected dispatch failed", async () => {
    const d = deps({
      dispatcher: {
        dispatch: vi.fn(async () => ({ status: "error" as const, error: "cap" })),
        cancel: vi.fn(async () => {}),
      },
    });
    const result = await spawnDelegatedRun(d, { ...INPUT, runId: "run-2" });
    expect(result).toMatchObject({ ok: false, code: "ASSISTANT_UNAVAILABLE", error: "cap" });
    expect(d.createRun).toHaveBeenCalledWith(expect.objectContaining({ budgetMs: DEFAULT_RUN_BUDGET_MS }));
    expect(d.updateRun).toHaveBeenCalledWith({ runId: "run-2", status: "failed", error: "cap" });
  });

  it("refuses to dispatch when the registry row cannot be recorded", async () => {
    const d = deps({ createRun: vi.fn(async () => null) });
    const result = await spawnDelegatedRun(d, INPUT);
    expect(result).toMatchObject({ ok: false, code: "ASSISTANT_UNAVAILABLE" });
    expect(d.dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("reports a cap refusal when a parallel spawn wins the last slot (atomic create)", async () => {
    // The atomic create is authoritative: both spawns pass the pre-read, the
    // first insert wins, the second is refused by the guarded INSERT and the
    // re-read yields the cap-specific refusal.
    let active = 0;
    const createRun = vi.fn(async (input) => {
      if (active >= THREAD_RUN_LIMIT) return null;
      active += 1;
      return row({ id: input.id });
    });
    const d = deps({
      createRun,
      counts: vi.fn(async () => ({ thread: active, project: active })),
    });
    const [a, b] = await Promise.all([
      spawnDelegatedRun(d, { ...INPUT, runId: "run-a" }),
      spawnDelegatedRun(d, { ...INPUT, runId: "run-b" }),
    ]);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    const refused = a.ok ? b : a;
    expect(refused).toMatchObject({ ok: false, code: "ASSISTANT_RUN_CAP_EXCEEDED" });
    expect(active).toBe(1);
  });

  it("passes the atomic caps into createRun", async () => {
    const d = deps();
    await spawnDelegatedRun(d, { ...INPUT, runId: "run-caps" });
    expect(d.createRun).toHaveBeenCalledWith(
      expect.objectContaining({ maxThreadRuns: THREAD_RUN_LIMIT, maxProjectRuns: PROJECT_RUN_LIMIT })
    );
  });
});

describe("dispatchRegisteredRun", () => {
  const dispatchInput = { runId: "r1", goal: "g", projectId: "p1", threadKey: "chat:c1", mode: "ask", budgetMs: 5000 };

  it("dispatches an existing run and marks it running without inserting", async () => {
    const d = deps();
    const result = await dispatchRegisteredRun(d, dispatchInput);
    expect(result).toEqual({ ok: true, runId: "r1" });
    expect(d.dispatcher.dispatch).toHaveBeenCalledWith(dispatchInput);
    expect(d.updateRun).toHaveBeenCalledWith({ runId: "r1", status: "running" });
    expect(d.createRun).not.toHaveBeenCalled();
    expect(d.counts).not.toHaveBeenCalled();
  });

  it("marks a rejected dispatch failed", async () => {
    const d = deps({
      dispatcher: {
        dispatch: vi.fn(async () => ({ status: "error" as const, error: "boom" })),
        cancel: vi.fn(async () => {}),
      },
    });
    const result = await dispatchRegisteredRun(d, dispatchInput);
    expect(result).toEqual({ ok: false, code: "ASSISTANT_UNAVAILABLE", error: "boom" });
    expect(d.updateRun).toHaveBeenCalledWith({ runId: "r1", status: "failed", error: "boom" });
    expect(d.createRun).not.toHaveBeenCalled();
  });
});

describe("abortDelegatedRun", () => {
  it("404s an unknown run", async () => {
    const d = deps({ getRun: vi.fn(async () => null) });
    expect(await abortDelegatedRun(d, "nope")).toMatchObject({ ok: false, code: "ASSISTANT_RUN_NOT_FOUND" });
  });

  it("is a no-op on an already-terminal run", async () => {
    const d = deps({ getRun: vi.fn(async () => row({ status: "completed" })) });
    expect(await abortDelegatedRun(d, "r1")).toEqual({ ok: true });
    expect(d.dispatcher.cancel).not.toHaveBeenCalled();
  });

  it("cancels an active run and lands the terminal row", async () => {
    const d = deps({ getRun: vi.fn(async () => row({ status: "running" })) });
    expect(await abortDelegatedRun(d, "r1")).toEqual({ ok: true });
    expect(d.dispatcher.cancel).toHaveBeenCalledWith("r1");
    expect(d.updateRun).toHaveBeenCalledWith({ runId: "r1", status: "cancelled" });
  });
});

describe("runStatusForTerminal", () => {
  it("maps SDK terminals onto registry statuses", () => {
    expect(runStatusForTerminal("completed")).toBe("completed");
    expect(runStatusForTerminal("aborted")).toBe("cancelled");
    expect(runStatusForTerminal("error")).toBe("failed");
  });

  it("treats interrupted as non-terminal (soft seal) while the child may run", () => {
    expect(isTerminalAgentToolStatus("interrupted")).toBe(false);
    expect(isTerminalAgentToolStatus("interrupted", true)).toBe(false);
    expect(isTerminalAgentToolStatus("completed")).toBe(true);
    expect(isTerminalAgentToolStatus("error")).toBe(true);
    expect(isTerminalAgentToolStatus("aborted")).toBe(true);
  });

  it("treats interrupted with childStillRunning === false as a hard terminal", () => {
    expect(isTerminalAgentToolStatus("interrupted", false)).toBe(true);
  });
});
