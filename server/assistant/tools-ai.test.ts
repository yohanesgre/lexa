import { describe, expect, it, vi } from "vitest";
import {
  BLOCKED_WRITE_ERROR,
  buildReadTools,
  buildWriteTools,
  createAssistantWriteBudget,
  createBudgetedWriteExecutor,
  shouldSuspendOnProposal,
  READ_TOOL_NAMES,
  WRITE_TOOL_NAMES,
  type AssistantToolTransport,
  type ReadToolResponse,
  type WriteExecuteResponse,
  type WriteToolResponse,
} from "./tools-ai";
import { ASSISTANT_WRITE_TOOL_NAMES, parseWriteTools } from "./write-tools";
import { resolveAssistantToolPermissionMode, resolveThreadToolPermissionMode } from "../../shared/assistant";
import { MAX_WRITES_PER_TURN } from "./write-tool-names";

type AnyTool = { execute?: (args: unknown) => Promise<unknown> };

function makeTransport(over: Partial<AssistantToolTransport> = {}): AssistantToolTransport {
  return {
    read: async () => ({ ok: true, result: {} }),
    propose: async () => ({ ok: true, proposed: true, approvalId: "a1", batchId: "b1", seq: 0, name: "create_task" }),
    execute: async () => ({ ok: true, applied: true, result: {} }),
    ...over,
  };
}

describe("tools-ai read tools", () => {
  it("exposes exactly the names in READ_TOOL_NAMES", () => {
    const tools = buildReadTools({ transport: makeTransport(), available: new Set(READ_TOOL_NAMES) });
    expect(Object.keys(tools).sort()).toEqual([...READ_TOOL_NAMES].sort());
  });

  it("omits tools the caller did not mark available", () => {
    const tools = buildReadTools({ transport: makeTransport(), available: new Set(["get_task"]) });
    expect(Object.keys(tools)).toEqual(["get_task"]);
  });

  it("forwards name and args to the transport and returns the result", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const transport = makeTransport({
      read: async (name, args) => {
        calls.push({ name, args });
        return { ok: true, result: { task: { key: "LEX-1" } } };
      },
    });
    const tools = buildReadTools({ transport, available: new Set(["get_task"]) });
    const out = await (tools["get_task"] as AnyTool).execute!({ ref: "LEX-1" });
    expect(calls).toEqual([{ name: "get_task", args: { ref: "LEX-1" } }]);
    expect(out).toEqual({ task: { key: "LEX-1" } });
  });

  it("surfaces a transport failure as a recoverable { error } result", async () => {
    const transport = makeTransport({ read: async () => ({ ok: false, error: "task not found" }) });
    const tools = buildReadTools({ transport, available: new Set(["get_task"]) });
    const out = await (tools["get_task"] as AnyTool).execute!({ ref: "NOPE" });
    expect(out).toEqual({ error: "task not found" });
  });

  it("never calls the transport with a malformed read tool", () => {
    const tools = buildReadTools({ transport: makeTransport(), available: new Set(["bogus"]) });
    expect(tools["bogus"]).toBeUndefined();
  });
});

describe("tools-ai write tools", () => {
  it("the DO write-tool name set matches the Worker authority", () => {
    expect([...WRITE_TOOL_NAMES]).toEqual([...ASSISTANT_WRITE_TOOL_NAMES]);
  });

  it("builds only the enabled write tools", () => {
    const enabled = parseWriteTools("create_task, archive_task, bogus");
    const tools = buildWriteTools({ transport: makeTransport(), enabled, mode: "ask" });
    expect(Object.keys(tools).sort()).toEqual(["archive_task", "create_task"]);
  });

  it("ask mode proposes and returns the Worker result", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const transport = makeTransport({
      propose: async (name, args) => {
        calls.push({ name, args });
        return { ok: true, proposed: true, approvalId: "appr-1", batchId: "batch-1", seq: 2, name: "create_task" };
      },
    });
    const tools = buildWriteTools({ transport, enabled: ["create_task"], mode: "ask" });
    const out = await (tools["create_task"] as AnyTool).execute!({ title: "Write docs" });
    expect(calls).toEqual([{ name: "create_task", args: { title: "Write docs" } }]);
    expect(out).toEqual({ ok: true, proposed: true, approvalId: "appr-1", batchId: "batch-1", seq: 2, name: "create_task" });
  });

  it("ask mode returns the Worker's proposal refusal unchanged", async () => {
    const transport = makeTransport({
      propose: async () => ({ ok: false, proposed: false, error: "task 'X' not found" }),
    });
    const tools = buildWriteTools({ transport, enabled: ["update_task"], mode: "ask" });
    const out = await (tools["update_task"] as AnyTool).execute!({ ref: "X", title: "Y" });
    expect(out).toEqual({ ok: false, proposed: false, error: "task 'X' not found" });
  });

  it("auto mode executes immediately and never proposes", async () => {
    const propose = vi.fn();
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const transport = makeTransport({
      propose,
      execute: async (name, args) => {
        calls.push({ name, args });
        return { ok: true, applied: true, result: { id: "t1" } } satisfies WriteExecuteResponse;
      },
    });
    const tools = buildWriteTools({ transport, enabled: ["create_task"], mode: "auto" });
    const out = await (tools["create_task"] as AnyTool).execute!({ title: "Write docs" });
    expect(calls).toEqual([{ name: "create_task", args: { title: "Write docs" } }]);
    expect(propose).not.toHaveBeenCalled();
    expect(out).toEqual({ ok: true, applied: true, result: { id: "t1" } });
    // No `proposed` field — the suspend stop-condition only fires on
    // `proposed === true`, so auto can never suspend.
    expect((out as { proposed?: unknown }).proposed).toBeUndefined();
  });

  it("auto mode surfaces an apply failure as a recoverable result", async () => {
    const transport = makeTransport({
      execute: async () => ({ ok: false, applied: false, error: "FORBIDDEN: nope" }),
    });
    const tools = buildWriteTools({ transport, enabled: ["create_task"], mode: "auto" });
    const out = await (tools["create_task"] as AnyTool).execute!({ title: "x" });
    expect(out).toEqual({ ok: false, applied: false, error: "FORBIDDEN: nope" });
  });

  it("deny mode refuses locally and never calls the Worker", async () => {
    const read = vi.fn();
    const propose = vi.fn();
    const execute = vi.fn();
    const transport = makeTransport({ read, propose, execute });
    const tools = buildWriteTools({ transport, enabled: ["create_task", "update_task"], mode: "deny" });
    const out = await (tools["create_task"] as AnyTool).execute!({ title: "Write docs" });
    expect(out).toEqual({ ok: false, denied: true, error: BLOCKED_WRITE_ERROR });
    expect(propose).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    // No `proposed` field: deny never suspends the turn.
    expect((out as { proposed?: unknown }).proposed).toBeUndefined();
  });
});

describe("per-turn write budget (auto mode, R5)", () => {
  it("allows exactly MAX_WRITES_PER_TURN slots, then refuses", () => {
    const budget = createAssistantWriteBudget(MAX_WRITES_PER_TURN);
    for (let i = 0; i < MAX_WRITES_PER_TURN; i++) {
      expect(budget.tryTake()).toBe(true);
    }
    expect(budget.tryTake()).toBe(false);
  });

  it("counts one bulk call as a single slot", () => {
    const budget = createAssistantWriteBudget(1);
    expect(budget.tryTake()).toBe(true);
    expect(budget.tryTake()).toBe(false);
  });

  it("refuses the 9th transport attempt without calling the Worker executor", async () => {
    const calls: string[] = [];
    const execute = createBudgetedWriteExecutor(
      createAssistantWriteBudget(MAX_WRITES_PER_TURN),
      MAX_WRITES_PER_TURN,
      async (name) => {
        calls.push(name);
        return { ok: true, applied: true };
      }
    );
    for (let i = 0; i < MAX_WRITES_PER_TURN; i++) {
      await expect(execute("create_task", {})).resolves.toEqual({ ok: true, applied: true });
    }
    await expect(execute("create_task", {})).resolves.toEqual({
      ok: false,
      applied: false,
      error: `write budget exceeded — at most ${MAX_WRITES_PER_TURN} writes per turn`,
    });
    expect(calls).toHaveLength(MAX_WRITES_PER_TURN);
  });
});

describe("write-tool descriptions are mode-aware (NIT)", () => {
  it("keeps ask-only approval wording in ask mode", () => {
    const tools = buildWriteTools({ transport: makeTransport(), enabled: ["update_task"], mode: "ask" });
    const description = (tools["update_task"] as { description?: string }).description ?? "";
    expect(description).toContain("Requires user approval");
    expect(description).toMatch(/^Propose /);
  });

  it("strips approval wording and the Propose prefix outside ask mode", () => {
    for (const mode of ["auto", "deny"] as const) {
      const tools = buildWriteTools({ transport: makeTransport(), enabled: ["update_task", "create_task"], mode });
      const update = (tools["update_task"] as { description?: string }).description ?? "";
      expect(update).not.toContain("Requires user approval");
      expect(update).not.toMatch(/^Propose /);
      const create = (tools["create_task"] as { description?: string }).description ?? "";
      expect(create).not.toContain("NOT applied until the user approves");
      expect(create).not.toContain("Propose creating");
    }
  });
});

describe("shouldSuspendOnProposal (D3/D6)", () => {
  const proposed = (toolName: string, output: unknown) => [{ toolName, output }];

  it("suspends in ask mode only on a successful proposal", () => {
    expect(shouldSuspendOnProposal("ask", ["create_task"], proposed("create_task", { proposed: true }))).toBe(true);
    expect(shouldSuspendOnProposal("ask", ["create_task"], proposed("create_task", { proposed: false }))).toBe(false);
    expect(shouldSuspendOnProposal("ask", ["create_task"], proposed("create_task", null))).toBe(false);
  });

  it("never suspends for auto or deny, even on a proposed-looking output", () => {
    expect(shouldSuspendOnProposal("auto", ["create_task"], proposed("create_task", { proposed: true }))).toBe(false);
    expect(shouldSuspendOnProposal("deny", ["create_task"], proposed("create_task", { proposed: true }))).toBe(false);
  });

  it("ignores a proposed result from a tool outside the enabled write set", () => {
    expect(shouldSuspendOnProposal("ask", ["update_task"], proposed("create_task", { proposed: true }))).toBe(false);
    expect(shouldSuspendOnProposal("ask", [], proposed("create_task", { proposed: true }))).toBe(false);
  });
});

describe("permission-mode envelope (D2/D5/D6)", () => {
  it("captures the send envelope over the sticky value", () => {
    expect(resolveAssistantToolPermissionMode("auto", "ask")).toBe("auto");
    expect(resolveAssistantToolPermissionMode("deny", "auto")).toBe("deny");
    expect(resolveAssistantToolPermissionMode("ask", "auto")).toBe("ask");
  });

  it("keeps the sticky value when the envelope is absent (resume/old client)", () => {
    expect(resolveAssistantToolPermissionMode(undefined, "auto")).toBe("auto");
    expect(resolveAssistantToolPermissionMode(undefined, "deny")).toBe("deny");
    expect(resolveAssistantToolPermissionMode(undefined, undefined)).toBe("ask");
  });

  it("resolves an invalid/missing mode to ask", () => {
    expect(resolveAssistantToolPermissionMode("bogus", "auto")).toBe("ask");
    expect(resolveAssistantToolPermissionMode(null, "deny")).toBe("ask");
    expect(resolveAssistantToolPermissionMode(undefined, "bogus")).toBe("ask");
  });

  it("forces ask for task/wiki threads even with a crafted envelope (D5 chat-only)", () => {
    expect(resolveThreadToolPermissionMode("task", "auto", "auto")).toBe("ask");
    expect(resolveThreadToolPermissionMode("wiki", "deny", "deny")).toBe("ask");
    expect(resolveThreadToolPermissionMode(null, "auto", "auto")).toBe("ask");
    expect(resolveThreadToolPermissionMode("chat", "auto", "ask")).toBe("auto");
    expect(resolveThreadToolPermissionMode("chat", undefined, "deny")).toBe("deny");
  });
});

describe("ReadToolResponse / WriteToolResponse shapes", () => {
  it("keeps the transport contracts discriminated", () => {
    const r: ReadToolResponse = { ok: true, result: 1 };
    const w: WriteToolResponse = { ok: false, proposed: false, error: "x" };
    expect(r.ok && w.ok).toBe(false);
  });
});
