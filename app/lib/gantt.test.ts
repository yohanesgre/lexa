import { describe, expect, it } from "vitest";
import { parseDay, formatDay, addDays, buildRange, dayForX, xForDay, axisDays, clampDate, DAY_WIDTH_PX } from "./gantt";

describe("gantt date math", () => {
  it("parseDay/formatDay round-trip without TZ shift", () => {
    expect(formatDay(parseDay("2026-08-13"))).toBe("2026-08-13");
  });
  it("addDays crosses month and year boundaries", () => {
    expect(formatDay(addDays(parseDay("2026-12-30"), 5))).toBe("2027-01-04");
  });
  it("buildRange covers all items with day padding and includes today", () => {
    // earliest 2026-08-03 − 4 lead days = 2026-07-30; latest 2026-08-14 + 5 trail = 2026-08-19
    const r = buildRange([{ startAt: "2026-08-03", dueAt: "2026-08-14" }], "2026-08-13");
    expect(formatDay(r.from)).toBe("2026-07-30");
    expect(formatDay(r.to)).toBe("2026-08-19");
  });
  it("buildRange includes today even when items are in the past", () => {
    const r = buildRange([{ startAt: null, dueAt: "2026-01-01" }], "2026-08-13");
    // from = earliest item 2026-01-01 − 4 = 2025-12-28; to = max(latest item, today) + 5 = 2026-08-18
    expect(formatDay(r.from)).toBe("2025-12-28");
    expect(formatDay(r.to)).toBe("2026-08-18");
  });
  it("buildRange handles empty items with only today", () => {
    const r = buildRange([], "2026-08-13");
    expect(formatDay(r.from)).toBe("2026-08-09");
    expect(formatDay(r.to)).toBe("2026-08-18");
  });
  it("buildRange is day-aligned, not week-aligned — short data-driven window", () => {
    const r = buildRange([{ startAt: "2026-08-18", dueAt: "2026-08-29" }], "2026-08-18");
    expect(formatDay(r.from)).toBe("2026-08-14");
    expect(formatDay(r.to)).toBe("2026-09-03");
  });
  it("buildRange extends the end with future days to fill a min width", () => {
    // from = 08-14; minDays 40 → to = 08-14 + 39 = 09-22
    const r = buildRange([{ startAt: "2026-08-18", dueAt: "2026-08-29" }], "2026-08-18", { minDays: 40 });
    expect(formatDay(r.from)).toBe("2026-08-14");
    expect(formatDay(r.to)).toBe("2026-09-22");
    expect(axisDays(r.from, r.to)).toHaveLength(40);
  });
  it("buildRange minDays never trims a wider data-driven range", () => {
    // data range 08-14 → 09-03 = 21 days; minDays 10 should not shrink it
    const r = buildRange([{ startAt: "2026-08-18", dueAt: "2026-08-29" }], "2026-08-18", { minDays: 10 });
    expect(formatDay(r.to)).toBe("2026-09-03");
  });
  it("axisDays returns every day in the range inclusive", () => {
    const days = axisDays(parseDay("2026-08-10"), parseDay("2026-08-13"));
    expect(days).toHaveLength(4);
    expect(formatDay(days[0]!)).toBe("2026-08-10");
    expect(formatDay(days[3]!)).toBe("2026-08-13");
  });
  it("axisDays does not week-align a mid-week start", () => {
    const days = axisDays(parseDay("2026-08-13"), parseDay("2026-08-13"));
    expect(days).toHaveLength(1);
    expect(formatDay(days[0]!)).toBe("2026-08-13");
  });
  it("xForDay/dayForX round-trip snaps to day", () => {
    const start = parseDay("2026-07-27");
    const x = xForDay(parseDay("2026-08-13"), start);
    expect(dayForX(x, start)).toBe("2026-08-13");
  });
  it("xForDay uses the DAY_WIDTH_PX scale", () => {
    const start = parseDay("2026-07-27");
    expect(xForDay(parseDay("2026-07-29"), start)).toBe(2 * DAY_WIDTH_PX);
  });
  it("clampDate keeps in-range dates and pins out-of-range", () => {
    const from = parseDay("2026-08-06");
    const to = parseDay("2026-08-20");
    expect(formatDay(clampDate(parseDay("2026-08-13"), from, to))).toBe("2026-08-13");
    expect(formatDay(clampDate(parseDay("2026-01-01"), from, to))).toBe("2026-08-06");
    expect(formatDay(clampDate(parseDay("2027-01-01"), from, to))).toBe("2026-08-20");
  });
});
