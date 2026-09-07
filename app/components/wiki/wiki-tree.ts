import type { WikiPageMeta } from "../../../shared/types";

export type WikiNode = WikiPageMeta & { children: WikiNode[] };

export function buildTree(pages: WikiPageMeta[]): WikiNode[] {
  const byParent = new Map<string | null, WikiPageMeta[]>();
  for (const page of pages) {
    const list = byParent.get(page.parentId) ?? [];
    list.push(page);
    byParent.set(page.parentId, list);
  }
  const sort = (list: WikiPageMeta[]) => [...list].toSorted((a, b) => a.position - b.position);
  const recurse = (parentId: string | null): WikiNode[] => {
    return sort(byParent.get(parentId) ?? []).map((p) => ({ ...p, children: recurse(p.id) }));
  };
  return recurse(null);
}
