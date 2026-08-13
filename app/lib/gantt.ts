export const DAY_MS = 86_400_000;
export const DAY_WIDTH_PX = 18;

export function parseDay(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function formatDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}

export function weekStart(d: Date): Date {
  const day = d.getUTCDay();
  const diff = day === 0 ? 6 : day - 1; // Monday = 0 offset
  return addDays(d, -diff);
}

export function xForDay(d: Date, axisStart: Date): number {
  return Math.round((d.getTime() - axisStart.getTime()) / DAY_MS) * DAY_WIDTH_PX;
}

export function dayForX(x: number, axisStart: Date): string {
  const days = Math.round(x / DAY_WIDTH_PX);
  return formatDay(addDays(axisStart, days));
}

export function axisDays(from: Date, to: Date): Date[] {
  const start = weekStart(from);
  const end = weekStart(to);
  const out: Date[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

export function buildRange(
  items: { startAt: string | null; dueAt: string | null }[],
  today: string
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
  return { from: weekStart(addDays(from, -7)), to: nextMonday(addDays(to, 7)) };
}

// The Monday of the NEXT week (strictly after d) — or d itself when already a
// Monday. Keeps the padded range aligned to the week axis.
function nextMonday(d: Date): Date {
  const day = d.getUTCDay();
  if (day === 1) return d;
  return addDays(d, day === 0 ? 1 : 8 - day);
}

export function clampDate(d: Date, from: Date, to: Date): Date {
  if (d < from) return from;
  if (d > to) return to;
  return d;
}
