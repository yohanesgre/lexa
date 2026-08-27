export const DAY_MS = 86_400_000;
export const DAY_WIDTH_PX = 28;

export function parseDay(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!));
}

export function formatDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}

export function xForDay(d: Date, axisStart: Date): number {
  return Math.round((d.getTime() - axisStart.getTime()) / DAY_MS) * DAY_WIDTH_PX;
}

export function dayForX(x: number, axisStart: Date): string {
  const days = Math.round(x / DAY_WIDTH_PX);
  return formatDay(addDays(axisStart, days));
}

// Day-aligned axis: every day from `from` to `to` inclusive becomes a column.
export function axisDays(from: Date, to: Date): Date[] {
  const out: Date[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

// Modest padding on each side of the data-driven window.
const LEAD_PAD_DAYS = 4;
const TRAIL_PAD_DAYS = 5;

export function buildRange(
  items: { startAt: string | null; dueAt: string | null }[],
  today: string,
  opts: { minDays?: number } = {}
): { from: Date; to: Date } {
  const t = parseDay(today);
  let from = t;
  let to = t;
  for (const it of items) {
    for (const raw of [it.startAt, it.dueAt]) {
      if (!raw) continue;
      const d = parseDay(raw);
      if (d < from) from = d;
      if (d > to) to = d;
    }
  }
  // Short, data-driven window: pad the earliest item start and the latest
  // item end (the last milestone's end) by a few days. Day-granular, so the
  // range is weeks, not years — sprint bars visibly span their day columns.
  let from2 = addDays(from, -LEAD_PAD_DAYS);
  let to2 = addDays(to, TRAIL_PAD_DAYS);
  // Extend the end with future days so the grid fills the container width
  // (minDays = total day columns needed). Never trims the data-driven start.
  if (opts.minDays && opts.minDays > 0) {
    const current = Math.round((to2.getTime() - from2.getTime()) / DAY_MS) + 1;
    if (current < opts.minDays) to2 = addDays(from2, opts.minDays - 1);
  }
  return { from: from2, to: to2 };
}

export function clampDate(d: Date, from: Date, to: Date): Date {
  if (d < from) return from;
  if (d > to) return to;
  return d;
}