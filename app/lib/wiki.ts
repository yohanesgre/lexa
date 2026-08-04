import type { WikiPageMeta } from "../../shared/types";

export function firstRootPage(pages: WikiPageMeta[]): WikiPageMeta | undefined {
  const roots = pages.filter((p) => p.parentId === null);
  roots.sort((a, b) => a.position - b.position);
  return roots[0];
}
