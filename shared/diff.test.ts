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
    expect(r.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2 });
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
    const hunk = r.hunks[0];
    expect(hunk.lines).toHaveLength(2);
    const [del, add] = hunk.lines;
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
    const [del, add] = r.hunks[0].lines;
    expect(del.spans.map((s) => s.text).join("")).toBe(oldText);
    expect(add.spans.map((s) => s.text).join("")).toBe(newText);
  });

  it("unbalanced hunk (4 del, 1 add) renders plain lines without spans", () => {
    const oldText = "Root cause\n- Loader assumes chunk indices start at 0\n- Streaming system assigns indices from the world origin\nconst cx = chunkIndex - originChunkIndex;";
    const newText = "Root cause: the loader assumes chunk indices start at 0, but the streaming system assigns them from the world origin.";
    const r = diffText(oldText, newText);
    expect(r.additions).toBe(1);
    expect(r.deletions).toBe(4);
    const hunk = r.hunks[0];
    expect(hunk.lines).toHaveLength(5);
    for (const line of hunk.lines) {
      expect(line.spans).toEqual([]);
    }
  });

  it("adjacent changes merge into a single hunk (git behavior)", () => {
    const r = diffText("line1\nline2\nline3", "line1\nCHANGED\nline3");
    expect(r.hunks).toHaveLength(1);
    expect(r.hunks[0]).toMatchObject({ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 });
  });

  it("separate changes produce separate hunks", () => {
    const r = diffText("a\nb\nc\nd", "A\nb\nc\nD");
    expect(r.hunks).toHaveLength(2);
    expect(r.hunks[0].oldStart).toBe(1);
    expect(r.hunks[1].oldStart).toBe(4);
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
    const [del, add] = r.hunks[0].lines;
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
});
