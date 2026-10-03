// Cron / interval scheduling helper (ADR-0004 §4; H7).
//
// Pure, UTC-based, dependency-free. Supports the standard five fields
// (`minute hour day-of-month month day-of-week`) with `*`, lists, ranges and
// step values (`*/n`, `a-b/n`). Day-of-week accepts 0–7 with both 0 and 7
// meaning Sunday. When BOTH day-of-month and day-of-week are restricted, a day
// matches if EITHER matches (Vixie-cron semantics).
//
// `nextCronRun` walks minute by minute from the first minute strictly after
// `from`, capped at one year; a schedule that never fires inside the window
// returns `null` (fail-open: the dispatcher leaves it for a later tick).

export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

const MINUTE_MS = 60_000;
const SEARCH_WINDOW_MS = 366 * 24 * 60 * MINUTE_MS;

interface FieldSpec {
  min: number;
  max: number;
  /** Normalize a raw value into the stored domain (e.g. 7→0 for Sunday). */
  normalize?: (value: number) => number;
}

function parseField(raw: string, spec: FieldSpec): Set<number> | null {
  const out = new Set<number>();
  const normalize = spec.normalize ?? ((v: number) => v);
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "") return null;
    const [rangePart, stepPart] = trimmed.split("/");
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart)) return null;
      step = Number(stepPart);
      if (step < 1) return null;
    }
    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = spec.min;
      end = spec.max;
    } else if (rangePart!.includes("-")) {
      const [a, b] = rangePart!.split("-");
      if (!/^\d+$/.test(a ?? "") || !/^\d+$/.test(b ?? "")) return null;
      start = Number(a);
      end = Number(b);
    } else {
      if (!/^\d+$/.test(rangePart!)) return null;
      start = Number(rangePart);
      end = start;
    }
    if (start < spec.min || end > spec.max || start > end) return null;
    for (let v = start; v <= end; v += step) out.add(normalize(v));
  }
  return out.size > 0 ? out : null;
}

/** Parse a five-field cron expression; `null` when malformed. */
export function parseCron(expression: string): CronFields | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minuteRaw, hourRaw, domRaw, monthRaw, dowRaw] = parts as [string, string, string, string, string];
  const minute = parseField(minuteRaw, { min: 0, max: 59 });
  const hour = parseField(hourRaw, { min: 0, max: 23 });
  const dom = parseField(domRaw, { min: 1, max: 31 });
  const month = parseField(monthRaw, { min: 1, max: 12 });
  const dow = parseField(dowRaw, { min: 0, max: 7, normalize: (v) => (v === 7 ? 0 : v) });
  if (!minute || !hour || !dom || !month || !dow) return null;
  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domRestricted: domRaw !== "*",
    dowRestricted: dowRaw !== "*",
  };
}

function matches(fields: CronFields, date: Date): boolean {
  if (!fields.minute.has(date.getUTCMinutes())) return false;
  if (!fields.hour.has(date.getUTCHours())) return false;
  if (!fields.month.has(date.getUTCMonth() + 1)) return false;
  const domMatch = fields.dom.has(date.getUTCDate());
  const dowMatch = fields.dow.has(date.getUTCDay());
  if (fields.domRestricted && fields.dowRestricted) return domMatch || dowMatch;
  if (fields.domRestricted) return domMatch;
  if (fields.dowRestricted) return dowMatch;
  return true;
}

/** First matching UTC minute strictly after `from`, or `null` within a year. */
export function nextCronRun(expression: string, from: Date): Date | null {
  const fields = parseCron(expression);
  if (!fields) return null;
  const start = new Date(Math.floor(from.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS);
  const deadline = start.getTime() + SEARCH_WINDOW_MS;
  for (let t = start.getTime(); t <= deadline; t += MINUTE_MS) {
    const candidate = new Date(t);
    if (matches(fields, candidate)) return candidate;
  }
  return null;
}

export interface ScheduleTiming {
  cron: string | null;
  intervalSeconds: number | null;
}

/**
 * Next occurrence for a schedule row: interval wins when set, else cron.
 * `null` means "never" (malformed cron / non-positive interval).
 */
export function nextRunAt(timing: ScheduleTiming, from: Date): Date | null {
  if (timing.intervalSeconds !== null && Number.isFinite(timing.intervalSeconds) && timing.intervalSeconds > 0) {
    return new Date(from.getTime() + Math.floor(timing.intervalSeconds) * 1000);
  }
  if (timing.cron !== null && timing.cron.trim() !== "") return nextCronRun(timing.cron, from);
  return null;
}
