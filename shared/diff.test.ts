import { describe, it, expect } from "vitest";
import { diffText, docToDiffText } from "./diff";
import { markdownToDoc } from "./markdown";
import type { TipTapDoc } from "./types";

describe("docToDiffText", () => {
  it("renders heading, list, code without markdown syntax", () => {
    const doc = markdownToDoc(
      "The furnace zone crash stems from an off-by-one in the chunk coordinate math when transitioning between zones.\n\n### Root cause\n\n- Loader assumes chunk indices start at 0\n- Streaming system assigns indices from the world origin\n\n```\nconst cx = chunkIndex - originChunkIndex;\n```"
    );
    expect(docToDiffText(doc)).toBe(
      "The furnace zone crash stems from an off-by-one in the chunk coordinate math when transitioning between zones.\nRoot cause\n- Loader assumes chunk indices start at 0\n- Streaming system assigns indices from the world origin\nconst cx = chunkIndex - originChunkIndex;"
    );
  });

  it("renders task items with checkboxes", () => {
    const doc = markdownToDoc("- [x] done\n- [ ] todo");
    expect(docToDiffText(doc)).toBe("- [x] done\n- [ ] todo");
  });

  it("returns empty string for content-less doc", () => {
    expect(docToDiffText({ type: "doc", content: [] })).toBe("");
    expect(docToDiffText(null as unknown as TipTapDoc)).toBe("");
  });
});

describe("diffText", () => {
  it("returns empty result for identical text", () => {
    const r = diffText("same text", "same text");
    expect(r.hunks).toEqual([]);
    expect(r.additions).toBe(0);
    expect(r.deletions).toBe(0);
  });

  it("pure addition becomes one hunk with empty old side", () => {
    const r = diffText("", "hello\nworld");
    expect(r.hunks).toHaveLength(1);
    expect(r.hunks[0]!).toMatchObject({ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2 });
    expect(r.additions).toBe(2);
    expect(r.deletions).toBe(0);
  });

  it("single-line replacement pairs word spans (wireframe hunk 1)", () => {
    const oldText =
      "The furnace zone crash stems from an off-by-one in the chunk coordinate math when transitioning between zones. #107 points to TilemapChunkLoader._loadChunk().";
    const newText =
      "Root cause: an off-by-one in the chunk coordinate math in TilemapChunkLoader._loadChunk() — chunk indices are assigned from the world origin, but the loader assumes they start at 0.";
    const r = diffText(oldText, newText);
    expect(r.hunks).toHaveLength(1);
    const hunk = r.hunks[0]!; // test guarantees presence
    expect(hunk.lines).toHaveLength(2);
    const del = hunk.lines[0]!; // test guarantees presence
    const add = hunk.lines[1]!; // test guarantees presence
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
  });

  it("reconstructs both lines from their spans", () => {
    const oldText = "The furnace zone crash stems from an off-by-one in the chunk coordinate math when transitioning between zones. #107 points to TilemapChunkLoader._loadChunk().";
    const newText = "Root cause: an off-by-one in the chunk coordinate math in TilemapChunkLoader._loadChunk() — chunk indices are assigned from the world origin, but the loader assumes they start at 0.";
    const r = diffText(oldText, newText);
    const lines = r.hunks[0]!.lines;
    const del = lines[0]!; // test guarantees presence
    const add = lines[1]!; // test guarantees presence
    expect(del.spans.map((s) => s.text).join("")).toBe(oldText);
    expect(add.spans.map((s) => s.text).join("")).toBe(newText);
  });

  it("unbalanced hunk (4 del, 1 add) renders plain lines without spans", () => {
    const oldText = "Root cause\n- Loader assumes chunk indices start at 0\n- Streaming system assigns indices from the world origin\nconst cx = chunkIndex - originChunkIndex;";
    const newText = "Root cause: the loader assumes chunk indices start at 0, but the streaming system assigns them from the world origin.";
    const r = diffText(oldText, newText);
    expect(r.additions).toBe(1);
    expect(r.deletions).toBe(4);
    const hunk = r.hunks[0]!; // test guarantees presence
    expect(hunk.lines).toHaveLength(5);
    for (const line of hunk.lines) {
      expect(line.spans).toEqual([]);
    }
  });

  it("adjacent changes merge into a single hunk (git behavior)", () => {
    const r = diffText("line1\nline2\nline3", "line1\nCHANGED\nline3");
    expect(r.hunks).toHaveLength(1);
    expect(r.hunks[0]!).toMatchObject({ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 });
  });

  it("separate changes produce separate hunks", () => {
    const r = diffText("a\nb\nc\nd", "A\nb\nc\nD");
    expect(r.hunks).toHaveLength(2);
    expect(r.hunks[0]!.oldStart).toBe(1);
    expect(r.hunks[1]!.oldStart).toBe(4);
  });

  it("counts additions and deletions", () => {
    const r = diffText("one\ntwo\nthree", "one\nTWO\nthree\nfour");
    expect(r.additions).toBe(2);
    expect(r.deletions).toBe(1);
  });

  it("word diff keeps spacing when merging adjacent tokens", () => {
    const oldLine = "when transitioning between zones. #107 points to";
    const newLine = "— chunk indices are assigned from the world origin";
    const r = diffText(oldLine, newLine);
    const lines2 = r.hunks[0]!.lines;
    const del = lines2[0]!; // test guarantees presence
    const add = lines2[1]!; // test guarantees presence
    const delMerged = del.spans.filter((s) => s.kind === "del").map((s) => s.text).join("");
    const addMerged = add.spans.filter((s) => s.kind === "add").map((s) => s.text).join("");
    expect(delMerged).toBe(oldLine);
    expect(addMerged).toBe(newLine);
    expect(del.spans.some((s) => s.kind === "same")).toBe(false);
    expect(add.spans.some((s) => s.kind === "same")).toBe(false);
  });

  it("diff of markdown round-trip matches wireframe shape", () => {
    const oldDoc = markdownToDoc(
      "The furnace zone crash stems from an off-by-one in the chunk coordinate math when transitioning between zones.\n\n### Root cause\n\n- Loader assumes chunk indices start at 0\n- Streaming system assigns indices from the world origin\n\n```\nconst cx = chunkIndex - originChunkIndex; // missing -1 shift\n```"
    );
    const newDoc = markdownToDoc(
      "Root cause: an off-by-one in the chunk coordinate math in TilemapChunkLoader._loadChunk() — chunk indices are assigned from the world origin, but the loader assumes they start at 0."
    );
    const r = diffText(docToDiffText(oldDoc), docToDiffText(newDoc));
    expect(r.deletions).toBe(5);
    expect(r.additions).toBe(1);
    expect(r.hunks).toHaveLength(1);
  });

  it("keeps exact hunks under the cell budget", () => {
    const r = diffText("a\nb\nc", "a\nX\nc");
    expect(r.hunks).toHaveLength(1);
    expect(r.hunks[0]!.lines).toHaveLength(2);
    expect(r.additions).toBe(1);
    expect(r.deletions).toBe(1);
  });

  it("falls back to a coarse line diff past the cell budget", () => {
    const n = 1200;
    const oldText = Array.from({ length: n }, (_, i) => `old line ${i}`).join("\n");
    const newText = Array.from({ length: n }, (_, i) => `new line ${i}`).join("\n");
    const r = diffText(oldText, newText);
    expect(r.hunks).toHaveLength(1);
    expect(r.hunks[0]!).toMatchObject({ oldStart: 1, oldLines: n, newStart: 1, newLines: n });
    expect(r.additions).toBe(n);
    expect(r.deletions).toBe(n);
    expect(r.hunks[0]!.lines).toHaveLength(2 * n);
    expect(r.hunks[0]!.lines.every((l) => l.spans.length === 0)).toBe(true);
    expect(r.hunks[0]!.lines[0]!.kind).toBe("del");
    expect(r.hunks[0]!.lines[n]!.kind).toBe("add");
  });

  it("trims common prefix/suffix so a one-line change in a huge doc stays exact", () => {
    const n = 1500;
    const before = Array.from({ length: n }, (_, i) => `line ${i}`);
    const after = before.slice();
    after[700] = "changed line 700";
    const r = diffText(before.join("\n"), after.join("\n"));
    // Untrimmed this doc is past CELL_BUDGET and would coarse-diff the whole
    // document (n deletions + n additions); the trim must yield exactly one
    // changed line on each side, anchored at the original line number.
    expect(r.additions).toBe(1);
    expect(r.deletions).toBe(1);
    expect(r.hunks).toHaveLength(1);
    expect(r.hunks[0]!).toMatchObject({ oldStart: 701, oldLines: 1, newStart: 701, newLines: 1 });
    expect(r.hunks[0]!.lines.map((l) => l.kind)).toEqual(["del", "add"]);
  });

  it("returns zero counts for identical large inputs", () => {
    const n = 1500;
    const text = Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");
    const r = diffText(text, text);
    expect(r.additions).toBe(0);
    expect(r.deletions).toBe(0);
    expect(r.hunks).toEqual([]);
  });

  it("uses the coarse path when the trimmed middle still exceeds the cell budget", () => {
    const common = Array.from({ length: 50 }, (_, i) => `common ${i}`);
    const oldMid = Array.from({ length: 1100 }, (_, i) => `old ${i}`);
    const newMid = Array.from({ length: 1100 }, (_, i) => `new ${i}`);
    const r = diffText([...common, ...oldMid, ...common].join("\n"), [...common, ...newMid, ...common].join("\n"));
    expect(r.additions).toBe(1100);
    expect(r.deletions).toBe(1100);
    expect(r.hunks).toHaveLength(1);
    expect(r.hunks[0]!).toMatchObject({ oldStart: 51, oldLines: 1100, newStart: 51, newLines: 1100 });
    expect(r.hunks[0]!.lines).toHaveLength(2200);
    expect(r.hunks[0]!.lines.every((l) => l.spans.length === 0)).toBe(true);
    expect(r.hunks[0]!.lines[0]!.kind).toBe("del");
    expect(r.hunks[0]!.lines[1100]!.kind).toBe("add");
  });

  it("skips word spans when a line pair exceeds the cell budget", () => {
    const oldLine = Array.from({ length: 1001 }, (_, i) => `o${i}`).join(" ");
    const newLine = Array.from({ length: 1001 }, (_, i) => `n${i}`).join(" ");
    const r = diffText(oldLine, newLine);
    expect(r.hunks).toHaveLength(1);
    expect(r.hunks[0]!.lines).toHaveLength(2);
    expect(r.hunks[0]!.lines.every((l) => l.spans.length === 0)).toBe(true);
    expect(r.additions).toBe(1);
    expect(r.deletions).toBe(1);
  });
});
