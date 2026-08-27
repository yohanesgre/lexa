import { describe, expect, it } from "vitest";
import type { TipTapDoc } from "../../shared/types";
import type { HeraldWriteDiff } from "../../shared/herald";
import {
  MAX_WRITES_PER_TURN,
  APPROVAL_TTL_HOURS,
  HERALD_WRITE_TOOL_NAMES,
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
  createWriteRecorder,
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
    diff: { type: "task_create", title: `t${n}`, fields: {} } as HeraldWriteDiff,
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

describe("HERALD_WRITE_TOOL_NAMES", () => {
  it("covers exactly the 18 write tools", () => {
    expect(HERALD_WRITE_TOOL_NAMES).toHaveLength(19);
    expect(HERALD_WRITE_TOOL_NAMES).toContain("create_task");
    expect(HERALD_WRITE_TOOL_NAMES).toContain("update_sprint");
    expect(HERALD_WRITE_TOOL_NAMES).toContain("delete_task");
    expect(HERALD_WRITE_TOOL_NAMES).toContain("delete_wiki_page");
    expect(HERALD_WRITE_TOOL_NAMES).toContain("delete_milestone");
    expect(HERALD_WRITE_TOOL_NAMES).toContain("archive_sprint");
    expect(HERALD_WRITE_TOOL_NAMES).toContain("delete_sprint");
    expect(HERALD_WRITE_TOOL_NAMES).toContain("move_swimlane");
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
