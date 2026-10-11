// shared/db.ts row→Task mapping + shared/diff.ts text diffing. Both are pure
// helpers consumed by the CLI; folded into one file at depth-2 (db+diff merge).
import { describe, it, expect } from "vitest";
import { rowToTask } from "./db";
import type { TaskRow } from "./db";
import { diffText, docToDiffText } from "./diff";
import { markdownToDoc } from "./markdown";

const NOW = "2026-07-29T12:00:00Z";

describe("rowToTask", () => {
  const row: TaskRow = { id: "t1", key: "EG-1", project_id: "p1", column_id: "c1", swimlane_id: "s1", title: "Fix bug", description: '{"type":"doc","content":[]}', priority: "prio-opt-1", type: "type-opt-1", assignees: "alice", position: "a0", due_at: null, archived_at: null, github_issue_id: null, github_issue_number: null, github_repo: null, github_synced_state: null, created_at: NOW, updated_at: NOW, github_issues_raw: null };

  it("splits assignees on || and parses the description as a TipTap doc", () => {
    const t = rowToTask({ ...row, assignees: "alice||bob", description: '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"hi"}]}]}' });
    expect(t.assignees).toEqual(["alice", "bob"]);
    expect(t.description).toEqual({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] });
  });

  it("builds the githubs array from the SQL JSON aggregate (url shape, empty title→null)", () => {
    const linked: TaskRow = { ...row, github_issues_raw: JSON.stringify([{ issueId: "ghi1", issueNumber: 42, repo: "owner/repo", syncedState: "open", pushFailed: 0, title: null }]) };
    const t = rowToTask(linked);
    expect(t.githubs).toEqual([{
      issueId: "ghi1", issueNumber: 42, repo: "owner/repo", title: null,
      url: "https://github.com/owner/repo/issues/42",
      syncedState: "open", outOfSync: false, pushFailed: false,
    }]);
    const emptyTitle: TaskRow = { ...row, github_issues_raw: JSON.stringify([{ issueId: "ghi1", issueNumber: 42, repo: "owner/repo", syncedState: "open", pushFailed: 0, title: "" }]) };
    expect(rowToTask(emptyTitle).githubs[0]!.title).toBeNull();
  });

  it("computes outOfSync from the column githubState arg or the column_github_state row fallback", () => {
    const linked: TaskRow = { ...row, github_issues_raw: JSON.stringify([{ issueId: "ghi1", issueNumber: 1, repo: "r", syncedState: "open", pushFailed: 0, title: null }]) };
    expect(rowToTask(linked, "closed").githubs[0]!.outOfSync).toBe(true);
    const fallback: TaskRow = { ...linked, github_issues_raw: JSON.stringify([{ issueId: "ghi1", issueNumber: 1, repo: "r", syncedState: "closed", pushFailed: 0, title: null }]), column_github_state: "open" };
    expect(rowToTask(fallback).githubs[0]!.outOfSync).toBe(true);
  });
});

describe("docToDiffText", () => {
  it("renders heading, list and code content without markdown syntax", () => {
    const doc = markdownToDoc(
      "The furnace zone crash stems from an off-by-one in the chunk coordinate math when transitioning between zones.\n\n### Root cause\n\n- Loader assumes chunk indices start at 0\n- Streaming system assigns indices from the world origin\n\n```\nconst cx = chunkIndex - originChunkIndex;\n```"
    );
    expect(docToDiffText(doc)).toBe(
      "The furnace zone crash stems from an off-by-one in the chunk coordinate math when transitioning between zones.\nRoot cause\n- Loader assumes chunk indices start at 0\n- Streaming system assigns indices from the world origin\nconst cx = chunkIndex - originChunkIndex;"
    );
  });
});

describe("diffText", () => {
  it("pure addition becomes one hunk with an empty old side, and counts are reported", () => {
    const r = diffText("", "hello\nworld");
    expect(r.hunks).toHaveLength(1);
    expect(r.hunks[0]!).toMatchObject({ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2 });
    expect(r.additions).toBe(2);
    expect(r.deletions).toBe(0);
    const mixed = diffText("one\ntwo\nthree", "one\nTWO\nthree\nfour");
    expect(mixed.additions).toBe(2);
    expect(mixed.deletions).toBe(1);
  });

  it("pairs word spans on a single-line replacement and reconstructs both lines", () => {
    const oldText =
      "The furnace zone crash stems from an off-by-one in the chunk coordinate math when transitioning between zones. #107 points to TilemapChunkLoader._loadChunk().";
    const newText =
      "Root cause: an off-by-one in the chunk coordinate math in TilemapChunkLoader._loadChunk() — chunk indices are assigned from the world origin, but the loader assumes they start at 0.";
    const r = diffText(oldText, newText);
    expect(r.hunks).toHaveLength(1);
    const hunk = r.hunks[0]!;
    expect(hunk.lines).toHaveLength(2);
    const del = hunk.lines[0]!;
    const add = hunk.lines[1]!;
    expect(del.kind).toBe("del");
    expect(add.kind).toBe("add");
    const delSame = del.spans.filter((s) => s.kind === "same").map((s) => s.text).join("");
    const addSame = add.spans.filter((s) => s.kind === "same").map((s) => s.text).join("");
    expect(delSame).toBe(addSame);
    expect(delSame).toContain("an off-by-one in the chunk coordinate math");
    expect(delSame).toContain("TilemapChunkLoader");
    expect(delSame).toContain("_loadChunk");
    expect(del.spans.some((s) => s.kind === "del" && s.text.startsWith("The furnace zone crash stems"))).toBe(true);
    expect(del.spans.some((s) => s.kind === "del" && s.text.includes("when transitioning between zones"))).toBe(true);
    expect(add.spans.some((s) => s.kind === "add" && s.text === "Root cause:")).toBe(true);
    expect(add.spans.some((s) => s.kind === "add" && s.text.includes("— chunk indices are assigned from the world origin"))).toBe(true);
    expect(del.spans.map((s) => s.text).join("")).toBe(oldText);
    expect(add.spans.map((s) => s.text).join("")).toBe(newText);
  });
});
