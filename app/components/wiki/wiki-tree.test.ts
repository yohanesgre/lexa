// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { WikiPageMeta } from "../../../shared/types";
import { buildParentOptions, buildTree, collectDescendantIds, flattenPages } from "./wiki-tree";

function meta(id: string, title: string, parentId: string | null, position = 0): WikiPageMeta {
  return {
    id,
    projectId: "p1",
    title,
    slug: title.toLowerCase().replace(/\s+/g, "-"),
    parentId,
    position,
    updatedBy: null,
    updatedByName: null,
    updatedAt: "2026-08-20T10:00:00.000Z",
  };
}

const root = meta("w1", "Root", null);
const child = meta("w2", "Child", "w1");
const grand = meta("w3", "Grand", "w2");
const other = meta("w4", "Other", null, 1);
const pages = [root, child, grand, other];

describe("flattenPages", () => {
  it("walks depth-first with a depth annotation, siblings ordered by position", () => {
    expect(flattenPages(pages).map((p) => [p.id, p.depth])).toEqual([
      ["w1", 0],
      ["w2", 1],
      ["w3", 2],
      ["w4", 0],
    ]);
  });
});

describe("collectDescendantIds", () => {
  it("returns the root plus every descendant, excluding unrelated pages", () => {
    expect(collectDescendantIds(pages, "w1")).toEqual(new Set(["w1", "w2", "w3"]));
  });

  it("terminates on a two-node parent cycle", () => {
    const a = meta("a", "A", "b");
    const b = meta("b", "B", "a");
    expect(collectDescendantIds([a, b], "a")).toEqual(new Set(["a", "b"]));
  });
});

describe("buildParentOptions", () => {
  it("drops excluded pages and their subtrees, keeping the same options as the modal picker", () => {
    const excluded = collectDescendantIds(pages, "w2");
    expect(buildParentOptions(pages, excluded).map((p) => [p.id, p.depth])).toEqual([
      ["w1", 0],
      ["w4", 0],
    ]);
  });

});

describe("cycle safety", () => {
  it("terminates on a reachable duplicate-id cycle without duplicating rows", () => {
    const a = meta("a", "A", null);
    const b = meta("b", "B", "a");
    const aDup = meta("a", "A2", "b");
    expect(flattenPages([a, b, aDup]).map((p) => p.id)).toEqual(["a", "b"]);
    expect(buildParentOptions([a, b, aDup], new Set()).map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("buildTree terminates on a reachable duplicate-id cycle", () => {
    const a = meta("a", "A", null);
    const b = meta("b", "B", "a");
    const aDup = meta("a", "A2", "b");
    const tree = buildTree([a, b, aDup]);
    expect(tree.map((node) => [node.id, node.children.map((c) => c.id)])).toEqual([["a", ["b"]]]);
  });
});
