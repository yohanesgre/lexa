import type { WikiPageMeta } from "../../../shared/types";

export type WikiNode = WikiPageMeta & { children: WikiNode[] };
export type WikiPageOption = WikiPageMeta & { depth: number };

function groupByParent(pages: WikiPageMeta[]): Map<string | null, WikiPageMeta[]> {
  const byParent = new Map<string | null, WikiPageMeta[]>();
  for (const page of pages) {
    const list = byParent.get(page.parentId) ?? [];
    list.push(page);
    byParent.set(page.parentId, list);
  }
  return byParent;
}

const byPosition = (list: WikiPageMeta[]) => [...list].toSorted((a, b) => a.position - b.position);

export function flattenPages(pages: WikiPageMeta[]): WikiPageOption[] {
  const byParent = groupByParent(pages);
  const result: WikiPageOption[] = [];
  const visited = new Set<string>();
  const recurse = (parentId: string | null, depth: number): void => {
    for (const page of byPosition(byParent.get(parentId) ?? [])) {
      if (visited.has(page.id)) continue;
      visited.add(page.id);
      result.push({ ...page, depth });
      recurse(page.id, depth + 1);
    }
  };
  recurse(null, 0);
  return result;
}

export function collectDescendantIds(pages: WikiPageMeta[], rootId: string): Set<string> {
  const childrenByParent = new Map<string, WikiPageMeta[]>();
  for (const page of pages) {
    if (!page.parentId) continue;
    const list = childrenByParent.get(page.parentId) ?? [];
    list.push(page);
    childrenByParent.set(page.parentId, list);
  }
  const excluded = new Set<string>([rootId]);
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const child of childrenByParent.get(id) ?? []) {
      if (excluded.has(child.id)) continue;
      excluded.add(child.id);
      stack.push(child.id);
    }
  }
  return excluded;
}

export function buildParentOptions(pages: WikiPageMeta[], excluded: Set<string>): WikiPageOption[] {
  const byParent = groupByParent(pages);
  const result: WikiPageOption[] = [];
  const visited = new Set<string>();
  const recurse = (parentId: string | null, depth: number): void => {
    for (const page of byPosition(byParent.get(parentId) ?? [])) {
      if (excluded.has(page.id) || visited.has(page.id)) continue;
      visited.add(page.id);
      result.push({ ...page, depth });
      recurse(page.id, depth + 1);
    }
  };
  recurse(null, 0);
  return result;
}

export function buildTree(pages: WikiPageMeta[]): WikiNode[] {
  const byParent = new Map<string | null, WikiPageMeta[]>();
  for (const page of pages) {
    const list = byParent.get(page.parentId) ?? [];
    list.push(page);
    byParent.set(page.parentId, list);
  }
  const sort = (list: WikiPageMeta[]) => [...list].toSorted((a, b) => a.position - b.position);
  const visited = new Set<string>();
  const recurse = (parentId: string | null): WikiNode[] => {
    const nodes: WikiNode[] = [];
    for (const p of sort(byParent.get(parentId) ?? [])) {
      if (visited.has(p.id)) continue;
      visited.add(p.id);
      nodes.push({ ...p, children: recurse(p.id) });
    }
    return nodes;
  };
  return recurse(null);
}
