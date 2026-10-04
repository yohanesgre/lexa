import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { targetOf, collectResumeResults, settledNoteLines } from "./resume-results";
import { buildResumeResultsNote } from "./build-stream";

describe("targetOf bulk args", () => {
  it("summarizes a refs list as '<n> tasks'", () => {
    expect(targetOf({ args: JSON.stringify({ refs: ["A", "B", "C"] }) })).toBe("3 tasks");
  });

  it("single ref stays the ref itself", () => {
    expect(targetOf({ args: JSON.stringify({ ref: "EG-1" }) })).toBe("EG-1");
  });

  it("empty/invalid args fall through", () => {
    expect(targetOf({ args: JSON.stringify({ refs: [] }) })).toBeUndefined();
    expect(targetOf({ args: "not json" })).toBeUndefined();
  });
});

describe("collectResumeResults bulk target in the executed-writes note", () => {
  it("renders the bulk summary as the note target", async () => {
    const rows = [
      {
        id: "a1",
        tool_name: "archive_task",
        args: JSON.stringify({ refs: Array.from({ length: 52 }, (_, i) => `NIM-${i + 1}`) }),
        status: "approved",
      },
    ];
    const { noteLines } = await Effect.runPromise(
      collectResumeResults(rows, () => Effect.succeed({ ok: true as const, result: undefined }))
    );
    expect(buildResumeResultsNote(noteLines)).toContain('- archive_task "52 tasks": applied');
  });

  it("surfaces a partial bulk failure with counts, never a bare 'applied'", async () => {
    const rows = [
      {
        id: "a1",
        tool_name: "delete_task",
        args: JSON.stringify({ refs: Array.from({ length: 10 }, (_, i) => `NIM-${i + 1}`) }),
        status: "approved",
      },
    ];
    const result = {
      applied: ["NIM-1"],
      failed: Array.from({ length: 9 }, (_, i) => ({ ref: `NIM-${i + 2}`, error: "TASK_HAS_CHILDREN: task has children" })),
      partial: true,
    };
    const { results, noteLines } = await Effect.runPromise(
      collectResumeResults(rows, () => Effect.succeed({ ok: true as const, result }))
    );
    expect(results[0]).toMatchObject({ approvalId: "a1", status: "applied", partial: { applied: 1, failed: 9 } });
    const note = buildResumeResultsNote(noteLines);
    expect(note).toContain('- delete_task "10 tasks": applied (9 of 10 failed: TASK_HAS_CHILDREN: task has children)');
    expect(note).not.toContain('- delete_task "10 tasks": applied\n');
  });

  it("keeps a fully-applied bulk line bare", async () => {
    const rows = [
      { id: "a1", tool_name: "delete_task", args: JSON.stringify({ refs: ["NIM-1", "NIM-2"] }), status: "approved" },
    ];
    const { results, noteLines } = await Effect.runPromise(
      collectResumeResults(rows, () => Effect.succeed({ ok: true as const, result: { applied: ["NIM-1", "NIM-2"], failed: [] } }))
    );
    expect(results[0]!.partial).toBeUndefined();
    expect(buildResumeResultsNote(noteLines)).toContain('- delete_task "2 tasks": applied');
  });

  it("notes an expired row without an approval result", async () => {
    const rows = [
      { id: "a1", tool_name: "update_task", args: JSON.stringify({ ref: "EG-1" }), status: "expired" },
    ];
    const { results, noteLines } = await Effect.runPromise(
      collectResumeResults(rows, () => Effect.succeed({ ok: true as const, result: undefined }))
    );
    expect(results).toEqual([]);
    expect(buildResumeResultsNote(noteLines)).toContain('- update_task "EG-1": expired (not executed)');
  });
});

describe("settledNoteLines", () => {
  it("maps rejected to denied and expired to expired, skipping approved", () => {
    const lines = settledNoteLines([
      { tool_name: "update_task", args: JSON.stringify({ ref: "EG-1" }), status: "rejected" },
      { tool_name: "delete_task", args: JSON.stringify({ ref: "EG-2" }), status: "expired" },
      { tool_name: "create_task", args: JSON.stringify({ title: "x" }), status: "approved" },
    ]);
    const note = buildResumeResultsNote(lines);
    expect(note).toContain("None of the proposed writes were executed.");
    expect(note).toContain('- update_task "EG-1": rejected (not executed)');
    expect(note).toContain('- delete_task "EG-2": expired (not executed)');
    expect(note).not.toContain("create_task");
  });

  it("returns an empty note when no rows are settled", () => {
    expect(buildResumeResultsNote(settledNoteLines([]))).toBe("");
  });
});
