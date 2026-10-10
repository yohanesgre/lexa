import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { TipTapDoc } from "../../shared/types";
import type { AssistantWriteDiff } from "../../shared/assistant";
import { executeAssistantWrite, type AssistantWriteExecutionCtx } from "./write-execution";
import type { AssistantPendingWriteRow } from "../repos/assistant-pending-writes.repo";
import { RowNotFound } from "../db/driver";
import { TaskHasChildren } from "../api/errors";
import {
  MAX_WRITES_PER_TURN,
  MAX_BULK_TASK_REFS,
  APPROVAL_TTL_HOURS,
  ASSISTANT_WRITE_TOOL_NAMES,
  parseWriteTools,
  buildTaskCreateDiff,
  buildTaskUpdateDiff,
  buildTaskRestoreDiff,
  buildWikiEditDiff,
  buildMilestoneCreateDiff,
  buildMilestoneArchiveDiff,
  buildSprintCreateDiff,
  buildTaskDeleteDiff,
  buildWikiDeleteDiff,
  buildMilestoneDeleteDiff,
  buildSprintArchiveDiff,
  buildSprintDeleteDiff,
  buildAssistantWriteTools,
  buildAutoWriteRecord,
  buildDenyWriteRecord,
  createWriteRecorder,
  type AssistantWriteToolDeps,
  type WriteRecorderInsertRow,
  type WriteTaskSnapshot,
} from "./write-tools";

const doc = (...text: string[]): TipTapDoc => ({
  type: "doc",
  content: text.map((t) => ({ type: "paragraph", content: [{ type: "text", text: t }] })),
});

const emptyDoc: TipTapDoc = { type: "doc", content: [] };

const snapshot: WriteTaskSnapshot = {
  id: "t1",
  key: "NIM-3",
  title: "Old title",
  columnName: "Todo",
  priority: "high",
  type: "bug",
  dueAt: "2026-01-01",
  assignees: ["u1", "u2"],
  descriptionText: "old body",
  archivedAt: null,
};

describe("parseWriteTools", () => {
  it("empty/null/whitespace input → []", () => {
    expect(parseWriteTools("")).toEqual([]);
    expect(parseWriteTools(null)).toEqual([]);
    expect(parseWriteTools(undefined)).toEqual([]);
    expect(parseWriteTools("   ")).toEqual([]);
  });

  it("splits on commas, trims parts", () => {
    expect(parseWriteTools("create_task, update_task")).toEqual(["create_task", "update_task"]);
    expect(parseWriteTools(" create_task ,update_task")).toEqual(["create_task", "update_task"]);
  });

  it("drops unknown names silently", () => {
    expect(parseWriteTools("create_task,bogus_tool,update_task")).toEqual(["create_task", "update_task"]);
  });

  it("dedupes while preserving first-seen order", () => {
    expect(parseWriteTools("update_task,create_task,update_task")).toEqual(["update_task", "create_task"]);
  });
});

describe("buildTaskCreateDiff", () => {
  it("title-only input yields empty fields", () => {
    expect(buildTaskCreateDiff({ title: "New task" })).toEqual({
      type: "task_create",
      title: "New task",
      fields: {},
    });
  });

  it("projects optional fields; TipTap description becomes extracted text", () => {
    const diff = buildTaskCreateDiff({
      title: "T",
      description: doc("first", "second"),
      priority: "p1",
      type: "task",
      dueAt: "2026-09-01",
      assigneeIds: ["a", "b"],
      parentTitle: "Parent",
    });
    expect(diff.fields).toEqual({
      description: "first\nsecond",
      priority: "p1",
      type: "task",
      dueAt: "2026-09-01",
      assignees: "a, b",
      parent: "Parent",
    });
  });

  it("TipTap-aware emptiness: an empty doc projects as empty text", () => {
    const diff = buildTaskCreateDiff({ title: "T", description: emptyDoc });
    expect(diff.fields.description).toBe("");
  });
});

describe("buildTaskUpdateDiff", () => {
  it("maps before values from the snapshot and normalizes '' to null", () => {
    const diff = buildTaskUpdateDiff(snapshot, [
      { field: "title", after: "New title" },
      { field: "description", after: "" },
      { field: "assignees", after: "u1" },
      { field: "dueAt", after: null },
    ]);
    expect(diff).toEqual({
      type: "task_update",
      taskRef: "NIM-3",
      taskTitle: "Old title",
      changes: [
        { field: "title", before: "Old title", after: "New title" },
        { field: "description", before: "old body", after: null },
        { field: "assignees", before: "u1, u2", after: "u1" },
        { field: "dueAt", before: "2026-01-01", after: null },
      ],
    });
  });

  it("empty assignee list projects before=null", () => {
    const diff = buildTaskUpdateDiff({ ...snapshot, assignees: [] }, [{ field: "assignees", after: "x" }]);
    expect(diff.changes[0]!.before).toBeNull();
  });
});

describe("buildWikiEditDiff", () => {
  it("extracts before/after text and keeps the next title when given", () => {
    const diff = buildWikiEditDiff(
      { slug: "intro", title: "Intro", text: "old content" },
      { title: "Intro v2", content: doc("new content") }
    );
    expect(diff).toEqual({
      type: "wiki_edit",
      slug: "intro",
      title: "Intro v2",
      beforeText: "old content",
      afterText: "new content",
    });
  });

  it("falls back to the page title and projects an empty doc as ''", () => {
    const diff = buildWikiEditDiff(
      { slug: "intro", title: "Intro", text: "" },
      { content: emptyDoc }
    );
    expect(diff.title).toBe("Intro");
    expect(diff.afterText).toBe("");
  });
});

describe("createWriteRecorder budget + persistence rows", () => {
  const turn = { projectId: "p1", documentType: "chat" as const, documentId: "c1", ownerUserId: "u1" };

  function makeRecorder() {
    const rows: WriteRecorderInsertRow[] = [];
    const recorder = createWriteRecorder(turn, async (row) => {
      rows.push(row);
    });
    return { recorder, rows };
  }

  const proposal = (n: number) => ({
    name: "create_task" as const,
    args: { title: `t${n}` },
    diff: { type: "task_create", title: `t${n}`, fields: {} } as AssistantWriteDiff,
  });

  it("accepts up to MAX_WRITES_PER_TURN proposals, then rejects the next", async () => {
    const { recorder } = makeRecorder();
    for (let i = 0; i < MAX_WRITES_PER_TURN; i++) {
      const r = await recorder.record(proposal(i));
      expect("error" in r).toBe(false);
    }
    const ninth = await recorder.record(proposal(MAX_WRITES_PER_TURN));
    expect(ninth).toEqual({
      error: `write budget exceeded — at most ${MAX_WRITES_PER_TURN} proposals per turn`,
    });
  });

  it("persists one row per proposal with batchId, monotonic seq, SQL-format expires_at", async () => {
    const { recorder, rows } = makeRecorder();
    const first = await recorder.record(proposal(0));
    const second = await recorder.record(proposal(1));
    if ("error" in first || "error" in second) throw new Error("unexpected budget rejection");
    expect(rows).toHaveLength(2);
    expect(first!.batchId).toBe(second.batchId);
    expect(second.seq).toBe(first!.seq + 1);
    for (const row of rows) {
      expect(row.projectId).toBe("p1");
      expect(row.documentType).toBe("chat");
      expect(row.documentId).toBe("c1");
      expect(row.ownerUserId).toBe("u1");
      expect(row.toolName).toBe("create_task");
      expect(JSON.parse(row.args as string)).toEqual({ title: `t${row.seq}` });
      expect(typeof row.expiresAt).toBe("string");
      expect(row.expiresAt as string).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    }
  });

  it("expires_at is ~APPROVAL_TTL_HOURS ahead of now", async () => {
    const { recorder, rows } = makeRecorder();
    await recorder.record(proposal(0));
    const expectedMs = Date.now() + APPROVAL_TTL_HOURS * 3_600_000;
    const actualMs = Date.parse((rows[0]!.expiresAt as string).replace(" ", "T") + "Z");
    expect(Math.abs(expectedMs - actualMs)).toBeLessThan(5_000);
  });

  it("drain returns queued proposals in seq order and empties the queue", async () => {
    const { recorder } = makeRecorder();
    await recorder.record(proposal(0));
    await recorder.record(proposal(1));
    const drained = recorder.drain();
    expect(drained.map((p) => p.seq)).toEqual([0, 1]);
    expect(recorder.drain()).toEqual([]);
  });
});

describe("buildTaskRestoreDiff", () => {
  it("toColumn is the snapshot's retained (pre-archive) column", () => {
    expect(buildTaskRestoreDiff(snapshot)).toEqual({
      type: "task_restore",
      taskRef: "NIM-3",
      taskTitle: "Old title",
      toColumn: "Todo",
    });
  });
});

describe("buildMilestoneCreateDiff", () => {
  it("dueAt included when given, omitted otherwise", () => {
    expect(buildMilestoneCreateDiff({ name: "M1", dueAt: "2026-12-01" })).toEqual({
      type: "milestone_create",
      name: "M1",
      dueAt: "2026-12-01",
    });
    expect(buildMilestoneCreateDiff({ name: "M1" })).toEqual({ type: "milestone_create", name: "M1" });
  });
});

describe("buildMilestoneArchiveDiff", () => {
  it("sprintsAffected included when > 0", () => {
    expect(buildMilestoneArchiveDiff({ name: "M1", sprintsAffected: 2 })).toEqual({
      type: "milestone_archive",
      name: "M1",
      sprintsAffected: 2,
    });
  });

  it("sprintsAffected omitted when 0 or undefined — no '0 sprints' row", () => {
    expect(buildMilestoneArchiveDiff({ name: "M1", sprintsAffected: 0 })).toEqual({
      type: "milestone_archive",
      name: "M1",
    });
    expect(buildMilestoneArchiveDiff({ name: "M1" })).toEqual({ type: "milestone_archive", name: "M1" });
  });
});

describe("buildSprintCreateDiff", () => {
  it("startAt/dueAt included when present, omitted otherwise", () => {
    expect(buildSprintCreateDiff({ name: "S1", startAt: "2026-09-01", dueAt: "2026-09-15" })).toEqual({
      type: "sprint_create",
      name: "S1",
      startAt: "2026-09-01",
      dueAt: "2026-09-15",
    });
    expect(buildSprintCreateDiff({ name: "S1" })).toEqual({ type: "sprint_create", name: "S1" });
    expect(buildSprintCreateDiff({ name: "S1", startAt: "2026-09-01" })).toEqual({
      type: "sprint_create",
      name: "S1",
      startAt: "2026-09-01",
    });
  });
});

describe("ASSISTANT_WRITE_TOOL_NAMES", () => {
  it("covers exactly the 18 write tools", () => {
    expect(ASSISTANT_WRITE_TOOL_NAMES).toHaveLength(19);
    expect(ASSISTANT_WRITE_TOOL_NAMES).toContain("create_task");
    expect(ASSISTANT_WRITE_TOOL_NAMES).toContain("update_sprint");
    expect(ASSISTANT_WRITE_TOOL_NAMES).toContain("delete_task");
    expect(ASSISTANT_WRITE_TOOL_NAMES).toContain("delete_wiki_page");
    expect(ASSISTANT_WRITE_TOOL_NAMES).toContain("delete_milestone");
    expect(ASSISTANT_WRITE_TOOL_NAMES).toContain("archive_sprint");
    expect(ASSISTANT_WRITE_TOOL_NAMES).toContain("delete_sprint");
    expect(ASSISTANT_WRITE_TOOL_NAMES).toContain("move_swimlane");
  });
});

describe("new diff builders", () => {
  it("buildTaskDeleteDiff caps title", () => {
    expect(buildTaskDeleteDiff(snapshot)).toEqual({ type: "task_delete", taskRef: "NIM-3", taskTitle: "Old title" });
  });
  it("buildWikiDeleteDiff", () => {
    expect(buildWikiDeleteDiff({ slug: "intro", title: "Intro" })).toEqual({ type: "wiki_delete", slug: "intro", title: "Intro" });
  });
  it("buildMilestoneDeleteDiff", () => {
    expect(buildMilestoneDeleteDiff({ name: "M1" })).toEqual({ type: "milestone_delete", name: "M1" });
  });
  it("buildSprintArchiveDiff / buildSprintDeleteDiff", () => {
    expect(buildSprintArchiveDiff({ name: "S1" })).toEqual({ type: "sprint_archive", name: "S1" });
    expect(buildSprintDeleteDiff({ name: "S1" })).toEqual({ type: "sprint_delete", name: "S1" });
  });
});

describe("executeAssistantWrite — execution-time project scope", () => {
  it("denies a task ref that resolves to another project", async () => {
    const marked: string[] = [];
    let updateCalled = false;
    const row = {
      id: "a1",
      project_id: "p1",
      owner_user_id: "u1",
      tool_name: "update_task",
      args: JSON.stringify({ ref: "foreign-task", title: "New title" }),
    } as unknown as AssistantPendingWriteRow;
    const ctx = {
      authz: { projectAccess: () => Effect.succeed({ role: "admin" }) },
      pendingWritesRepo: {
        markExecutionError: (id: string, message: string) => Effect.sync(() => { marked.push(`${id}:${message}`); }),
      },
      taskRepo: {
        findById: () => Effect.succeed({ id: "foreign-task", projectId: "p2" }),
        findByKey: () => Effect.succeed({ id: "foreign-task", projectId: "p2" }),
      },
      taskService: {
        update: () => { updateCalled = true; return Effect.void; },
      },
    } as unknown as AssistantWriteExecutionCtx;

    const out = (await Effect.runPromise(executeAssistantWrite(row, ctx))) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toContain("FORBIDDEN");
    expect(marked).toHaveLength(1);
    expect(updateCalled).toBe(false);
  });
});

describe("bulk task refs — archive/restore/delete proposals", () => {
  const tasks: Record<string, WriteTaskSnapshot> = {
    "NIM-1": { ...snapshot, id: "t1", key: "NIM-1", title: "Task 1", columnName: "Todo" },
    "NIM-2": { ...snapshot, id: "t2", key: "NIM-2", title: "Task 2", columnName: "Doing" },
    "NIM-3": { ...snapshot, id: "t3", key: "NIM-3", title: "Task 3", columnName: "Todo" },
    "NIM-4": { ...snapshot, id: "t4", key: "NIM-4", title: "Task 4", columnName: "Todo" },
  };

  interface TestTool {
    name: string;
    execute: (args: unknown) => Promise<{ proposed: boolean; approvalId?: string; error?: string }>;
    inputSchema: { safeParse: (v: unknown) => { success: boolean } };
  }

  const setup = () => {
    const recorded: Array<{ name: string; args: unknown; diff: AssistantWriteDiff; detail?: string }> = [];
    const deps: AssistantWriteToolDeps = {
      projectId: "p1",
      findTaskByRef: async (ref) => tasks[ref] ?? null,
      findColumn: async () => null,
      findWikiPageBySlug: async () => null,
      findMilestone: async () => null,
      countSprints: async () => 0,
      findSwimlane: async () => null,
      record: async (p) => {
        recorded.push(p as { name: string; args: unknown; diff: AssistantWriteDiff; detail?: string });
        return { approvalId: "ap-1", batchId: "b1", seq: recorded.length - 1 };
      },
    };
    const all = buildAssistantWriteTools(deps) as unknown as TestTool[];
    return { recorded, tool: (name: string) => all.find((t) => t.name === name)! };
  };

  it("bulk archive proposes one summary diff and detail", async () => {
    const { recorded, tool } = setup();
    const out = await tool("archive_task").execute({ refs: ["NIM-1", "NIM-2", "NIM-3", "NIM-4"] });
    expect(out).toEqual({ proposed: true, approvalId: "ap-1" });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.diff).toEqual({ type: "task_archive", taskRef: "4 tasks", taskTitle: "NIM-1, NIM-2, NIM-3…" });
    expect(recorded[0]!.detail).toBe("Archive 4 tasks");
    expect(recorded[0]!.args).toEqual({ refs: ["NIM-1", "NIM-2", "NIM-3", "NIM-4"] });
  });

  it("bulk delete proposes one summary diff and detail", async () => {
    const { recorded, tool } = setup();
    const out = await tool("delete_task").execute({ refs: ["NIM-1", "NIM-2"] });
    expect(out.proposed).toBe(true);
    expect(recorded[0]!.diff).toEqual({ type: "task_delete", taskRef: "2 tasks", taskTitle: "NIM-1, NIM-2" });
    expect(recorded[0]!.detail).toBe("Delete 2 tasks");
  });

  it("bulk restore keeps the diff type and summarizes", async () => {
    const { recorded, tool } = setup();
    await tool("restore_task").execute({ refs: ["NIM-1", "NIM-2"] });
    expect(recorded[0]!.diff).toEqual({ type: "task_restore", taskRef: "2 tasks", taskTitle: "NIM-1, NIM-2", toColumn: "Todo" });
    expect(recorded[0]!.detail).toBe("Restore 2 tasks");
  });

  it("unknown ref → proposed:false naming it, nothing recorded", async () => {
    const { recorded, tool } = setup();
    const out = await tool("archive_task").execute({ refs: ["NIM-1", "NIM-404"] });
    expect(out).toEqual({ proposed: false, error: "task 'NIM-404' not found" });
    expect(recorded).toHaveLength(0);
  });

  it("multiple unknown refs are all named", async () => {
    const { tool } = setup();
    const out = await tool("delete_task").execute({ refs: ["X-1", "Y-2"] });
    expect(out).toEqual({ proposed: false, error: "tasks not found: 'X-1', 'Y-2'" });
  });

  it("rejects > MAX_BULK_TASK_REFS refs, an empty list, and a missing ref/refs at the schema", () => {
    const { tool } = setup();
    const schema = tool("archive_task").inputSchema;
    const tooMany = Array.from({ length: MAX_BULK_TASK_REFS + 1 }, (_, i) => `NIM-${i + 1}`);
    expect(schema.safeParse({ refs: tooMany }).success).toBe(false);
    expect(schema.safeParse({ refs: [] }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ refs: tooMany.slice(0, MAX_BULK_TASK_REFS) }).success).toBe(true);
  });

  it("rejects ref together with refs (exactly one)", () => {
    const { recorded, tool } = setup();
    const schema = tool("delete_task").inputSchema as { safeParse: (v: unknown) => { success: boolean } };
    expect(schema.safeParse({ ref: "NIM-1" }).success).toBe(true);
    expect(schema.safeParse({ refs: ["NIM-1"] }).success).toBe(true);
    expect(schema.safeParse({ ref: "NIM-1", refs: ["NIM-2"] }).success).toBe(false);
    expect(recorded).toHaveLength(0);
  });

  it("dedupes + trims repeated refs before resolving (one summary, one proposal)", async () => {
    const { recorded, tool } = setup();
    const out = await tool("archive_task").execute({ refs: ["NIM-1", "NIM-1", " NIM-1 "] });
    expect(out).toEqual({ proposed: true, approvalId: "ap-1" });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.diff).toEqual({ type: "task_archive", taskRef: "NIM-1", taskTitle: "Task 1" });
  });

  it("single ref keeps the legacy diff and detail byte-identical", async () => {
    const { recorded, tool } = setup();
    await tool("archive_task").execute({ ref: "NIM-1" });
    expect(recorded[0]!.diff).toEqual({ type: "task_archive", taskRef: "NIM-1", taskTitle: "Task 1" });
    expect(recorded[0]!.detail).toBe("Archive NIM-1");
    await tool("delete_task").execute({ ref: "NIM-2" });
    expect(recorded[1]!.diff).toEqual({ type: "task_delete", taskRef: "NIM-2", taskTitle: "Task 2" });
    expect(recorded[1]!.detail).toBe('Delete NIM-2 "Task 2"');
  });

  it("a one-element refs list uses the single-task diff", async () => {
    const { recorded, tool } = setup();
    await tool("archive_task").execute({ refs: ["NIM-1"] });
    expect(recorded[0]!.diff).toEqual({ type: "task_archive", taskRef: "NIM-1", taskTitle: "Task 1" });
    expect(recorded[0]!.detail).toBe("Archive NIM-1");
  });
});

describe("executeAssistantWrite — bulk refs", () => {
  const tasks: Record<string, { id: string; projectId: string }> = {
    "NIM-1": { id: "t1", projectId: "p1" },
    "NIM-2": { id: "t2", projectId: "p1" },
    "NIM-3": { id: "t3", projectId: "p1" },
  };
  const lookup = (ref: string) => tasks[ref] ?? null;

  const makeCtx = (overrides: {
    archive?: (actor: unknown, id: string) => Effect.Effect<unknown, unknown>;
    restore?: (actor: unknown, id: string) => Effect.Effect<unknown, unknown>;
    delete?: (actor: unknown, id: string) => Effect.Effect<unknown, unknown>;
  } = {}) => {
    const marked: string[] = [];
    const ctx = {
      authz: { projectAccess: () => Effect.succeed({ role: "admin" }) },
      pendingWritesRepo: { markExecutionError: (id: string, message: string) => Effect.sync(() => { marked.push(`${id}:${message}`); }) },
      taskRepo: {
        findById: (id: string) => { const t = lookup(id); return t ? Effect.succeed(t) : Effect.fail(new RowNotFound({ table: "tasks" })); },
        findByKey: (key: string) => { const t = lookup(key); return t ? Effect.succeed(t) : Effect.fail(new RowNotFound({ table: "tasks" })); },
      },
      taskService: {
        archive: overrides.archive ?? (() => Effect.void),
        restore: overrides.restore ?? (() => Effect.void),
        delete: overrides.delete ?? (() => Effect.void),
      },
    } as unknown as AssistantWriteExecutionCtx;
    return { ctx, marked };
  };

  const rowFor = (tool: string, args: unknown) =>
    ({ id: "a1", project_id: "p1", owner_user_id: "u1", tool_name: tool, args: JSON.stringify(args) }) as unknown as AssistantPendingWriteRow;

  it("bulk archive applies every ref and reports none failed", async () => {
    const calls: string[] = [];
    const { ctx } = makeCtx({ archive: (_actor, id) => Effect.sync(() => { calls.push(id); }) });
    const out = (await Effect.runPromise(executeAssistantWrite(rowFor("archive_task", { refs: ["NIM-1", "NIM-2", "NIM-3"] }), ctx))) as { ok: boolean; result?: unknown };
    expect(out.ok).toBe(true);
    expect(out.result).toEqual({ applied: ["NIM-1", "NIM-2", "NIM-3"], failed: [] });
    expect(calls).toEqual(["t1", "t2", "t3"]);
  });

  it("dedupes + trims repeated refs so each task runs once", async () => {
    const calls: string[] = [];
    const { ctx } = makeCtx({ archive: (_actor, id) => Effect.sync(() => { calls.push(id); }) });
    const dup = (await Effect.runPromise(executeAssistantWrite(rowFor("archive_task", { refs: ["NIM-1", "NIM-1"] }), ctx))) as { ok: boolean };
    expect(dup.ok).toBe(true);
    expect(calls).toEqual(["t1"]);
    const out = (await Effect.runPromise(executeAssistantWrite(rowFor("archive_task", { refs: ["NIM-1", " NIM-1 ", "NIM-2"] }), ctx))) as { ok: boolean; result?: { applied: string[]; failed: unknown[] } };
    expect(out.ok).toBe(true);
    expect(out.result!.applied).toEqual(["NIM-1", "NIM-2"]);
    expect(out.result!.failed).toEqual([]);
    expect(calls).toEqual(["t1", "t1", "t2"]);
  });

  it("bulk delete reports a partial failure (subtask guard on one) honestly", async () => {
    const { ctx } = makeCtx({ delete: (_actor, id) => (id === "t2" ? Effect.fail(new TaskHasChildren({ taskId: id })) : Effect.void) });
    const out = (await Effect.runPromise(executeAssistantWrite(rowFor("delete_task", { refs: ["NIM-1", "NIM-2", "NIM-3"] }), ctx))) as { ok: boolean; result?: { applied: string[]; failed: Array<{ ref: string; error: string }>; partial?: boolean } };
    expect(out.ok).toBe(true);
    expect(out.result!.applied).toEqual(["NIM-1", "NIM-3"]);
    expect(out.result!.failed).toEqual([{ ref: "NIM-2", error: expect.stringContaining("TASK_HAS_CHILDREN") }]);
    expect(out.result!.partial).toBe(true);
  });

  it("bulk delete with zero applied fails the whole write", async () => {
    const { ctx, marked } = makeCtx({ delete: (_actor, id) => Effect.fail(new TaskHasChildren({ taskId: id })) });
    const out = (await Effect.runPromise(executeAssistantWrite(rowFor("delete_task", { refs: ["NIM-1", "NIM-2"] }), ctx))) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toContain("TASK_HAS_CHILDREN");
    expect(marked).toHaveLength(1);
  });

  it("a legacy {ref} row still executes as a single task", async () => {
    const calls: string[] = [];
    const { ctx } = makeCtx({ archive: (_actor, id) => Effect.sync(() => { calls.push(id); }) });
    const out = (await Effect.runPromise(executeAssistantWrite(rowFor("archive_task", { ref: "NIM-1" }), ctx))) as { ok: boolean };
    expect(out.ok).toBe(true);
    expect(calls).toEqual(["t1"]);
  });
});

// ADR-0005 §Port P1: auto applies the resolved write in-loop and returns the
// applied output (no pending row, no proposal); deny refuses locally without
// touching the data layer. Ask (the existing path) returns the proposal shape.
describe("write-tools auto/deny records (permission modes)", () => {
  interface ModeTool {
    name: string;
    execute: (args: unknown) => Promise<Record<string, unknown>>;
  }
  const depsWith = (record: AssistantWriteToolDeps["record"]): AssistantWriteToolDeps => ({
    projectId: "p1",
    findTaskByRef: async (ref) => (ref === "NIM-1" ? snapshot : null),
    findColumn: async () => null,
    findWikiPageBySlug: async () => null,
    findMilestone: async () => null,
    countSprints: async () => 0,
    findSwimlane: async () => null,
    record,
  });
  const tool = (record: AssistantWriteToolDeps["record"], name: string): ModeTool =>
    (buildAssistantWriteTools(depsWith(record)) as unknown as ModeTool[]).find((t) => t.name === name)!;

  it("auto applies in-loop and returns the applied output (no proposal)", async () => {
    const applied: Array<{ name: string; args: unknown }> = [];
    const record = buildAutoWriteRecord({
      apply: async (name, args) => { applied.push({ name, args }); return { ok: true, result: { id: "t9" } }; },
    });
    const out = await tool(record, "archive_task").execute({ ref: "NIM-1" });
    expect(out).toEqual({ ok: true, applied: true, result: { id: "t9" } });
    expect(applied).toEqual([{ name: "archive_task", args: { ref: "NIM-1" } }]);
  });

  it("auto executes an identical (tool, args) call once (loop safety net, M5b)", async () => {
    const applied: Array<{ name: string; args: unknown }> = [];
    const record = buildAutoWriteRecord({
      apply: async (name, args) => { applied.push({ name, args }); return { ok: true, result: { id: "t9" } }; },
    });
    const t = tool(record, "archive_task");
    const first = await t.execute({ ref: "NIM-1" });
    const second = await t.execute({ ref: "NIM-1" });
    expect(first).toEqual({ ok: true, applied: true, result: { id: "t9" } });
    expect(second).toEqual(first);
    expect(applied).toHaveLength(1);
  });

  it("auto still executes distinct args (dedupe is exact)", async () => {
    const applied: string[] = [];
    const record = buildAutoWriteRecord({
      apply: async (_name, args) => { applied.push(String((args as { name?: unknown }).name)); return { ok: true }; },
    });
    const t = tool(record, "create_milestone");
    await t.execute({ name: "Alpha" });
    await t.execute({ name: "Beta" });
    expect(applied).toEqual(["Alpha", "Beta"]);
  });

  it("auto surfaces an apply failure as a recoverable error", async () => {
    const record = buildAutoWriteRecord({ apply: async () => ({ ok: false, error: "FORBIDDEN: nope" }) });
    const out = await tool(record, "archive_task").execute({ ref: "NIM-1" });
    expect(out).toEqual({ proposed: false, error: "FORBIDDEN: nope" });
  });

  it("auto enforces the per-turn budget", async () => {
    const record = buildAutoWriteRecord({ limit: 1, apply: async () => ({ ok: true }) });
    const t = tool(record, "archive_task");
    expect(await t.execute({ ref: "NIM-1" })).toMatchObject({ ok: true, applied: true });
    const over = await t.execute({ ref: "NIM-1" });
    expect(over).toMatchObject({ proposed: false, error: expect.stringContaining("write budget exceeded") });
  });

  it("deny refuses locally without applying", async () => {
    const out = await tool(buildDenyWriteRecord(), "archive_task").execute({ ref: "NIM-1" });
    expect(out).toMatchObject({ proposed: false, error: expect.stringContaining("blocked") });
  });
});
