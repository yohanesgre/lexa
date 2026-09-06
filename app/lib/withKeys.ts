// Index-free React keys for sibling arrays rendered from token/node lists:
// the base key is content/type-derived and duplicate bases get a per-map
// occurrence suffix so keys stay unique within one sibling array.
export function withKeys<T>(
  items: readonly T[],
  base: (item: T) => string
): Array<{ item: T; key: string }> {
  const counts = new Map<string, number>();
  return items.map((item) => {
    const b = base(item);
    const n = counts.get(b) ?? 0;
    counts.set(b, n + 1);
    return { item, key: n === 0 ? b : `${b}#${n}` };
  });
}
