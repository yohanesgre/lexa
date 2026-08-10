import { describe, expect, it } from "vitest";
import { firstRootPage } from "./wiki";
import type { WikiPageMeta } from "../../shared/types";

const page = (id: string, position: number, parentId: string | null = null): WikiPageMeta => ({
  id, projectId: "p1", title: id, slug: id, parentId, position, updatedAt: "t",
});

describe("firstRootPage", () => {
  it("returns undefined for an empty list", () => {
    expect(firstRootPage([])).toBeUndefined();
  });

  it("returns the single root page", () => {
    expect(firstRootPage([page("a", 0)])?.id).toBe("a");
  });

  it("returns the root with the lowest position", () => {
    const pages = [page("b", 5), page("a", 1), page("c", 2)];
    expect(firstRootPage(pages)?.id).toBe("a");
  });

  it("ignores nested pages (parentId set)", () => {
    const pages = [page("child", 0, "root"), page("root", 3)];
    expect(firstRootPage(pages)?.id).toBe("root");
  });

  it("returns undefined when every page is nested", () => {
    const pages = [page("c1", 0, "root"), page("c2", 1, "root")];
    expect(firstRootPage(pages)).toBeUndefined();
  });

  it("does not mutate the input order", () => {
    const pages = [page("b", 5), page("a", 1)];
    firstRootPage(pages);
    expect(pages.map((p) => p.id)).toEqual(["b", "a"]);
  });
});
