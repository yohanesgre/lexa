import { describe, expect, it } from "vitest";
import { parseDay, formatDay, weekStart, addDays, buildRange, dayForX, xForDay, axisDays, clampDate, DAY_WIDTH_PX } from "./gantt";

describe("gantt date math", () => {
  it("parseDay/formatDay round-trip without TZ shift", () => {
    expect(formatDay(parseDay("2026-08-13"))).toBe("2026-08-13");
  });
  it("weekStart lands on Monday", () => {
    expect(formatDay(weekStart(parseDay("2026-08-13")))).toBe("2026-08-10"); // Thu → Mon
  });
  it("weekStart on a Sunday lands on the previous Monday", () => {
    expect(formatDay(weekStart(parseDay("2026-08-16")))).toBe("2026-08-10");
  });
  it("addDays crosses month and year boundaries", () => {
    expect(formatDay(addDays(parseDay("2026-12-30"), 5))).toBe("2027-01-04");
  });
  it("buildRange covers all items and always includes today", () => {
    const r = buildRange([{ startAt: "2026-08-03", dueAt: "2026-08-14" }], "2026-08-13");
    expect(formatDay(r.from)).toBe("2026-07-27"); // padded week before
    expect(formatDay(r.to)).toBe("2026-08-24");   // padded week after
  });
  it("buildRange includes today even when items are in the past", () => {
    const r = buildRange([{ startAt: null, dueAt: "2026-01-01" }], "2026-08-13");
    expect(formatDay(r.to)).toBe("2026-08-24");
  });
  it("buildRange handles empty items with only today", () => {
    const r = buildRange([], "2026-08-13");
    expect(formatDay(r.from)).toBe("2026-08-03");
    expect(formatDay(r.to)).toBe("2026-08-24");
  });
  it("axisDays returns Monday-aligned weeks covering the range", () => {
    const days = axisDays(parseDay("2026-07-27"), parseDay("2026-08-24"));
    expect(days).toHaveLength(29); // 4 weeks + 1 inclusive
    expect(formatDay(days[0])).toBe("2026-07-27");
  });
  it("axisDays aligns the start to the range's week start even mid-week", () => {
    const days = axisDays(parseDay("2026-08-13"), parseDay("2026-08-13"));
    expect(formatDay(days[0])).toBe("2026-08-10");
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
