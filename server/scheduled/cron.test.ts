import { describe, expect, it } from "vitest";
import { nextCronRun, nextRunAt, parseCron } from "./cron";

describe("parseCron", () => {
  it("parses wildcards, lists, ranges and steps", () => {
    const fields = parseCron("*/15 0,12 1-5 1,7 *");
    expect(fields).not.toBeNull();
    expect([...fields!.minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
    expect([...fields!.hour].sort((a, b) => a - b)).toEqual([0, 12]);
    expect([...fields!.dom].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect([...fields!.month].sort((a, b) => a - b)).toEqual([1, 7]);
    expect(fields!.domRestricted).toBe(true);
    expect(fields!.dowRestricted).toBe(false);
  });

  it("normalizes day-of-week 7 to Sunday 0", () => {
    const fields = parseCron("0 0 * * 7");
    expect([...fields!.dow]).toEqual([0]);
  });

  it("rejects malformed expressions", () => {
    expect(parseCron("")).toBeNull();
    expect(parseCron("* * * *")).toBeNull();
    expect(parseCron("60 * * * *")).toBeNull();
    expect(parseCron("* * * * 8")).toBeNull();
    expect(parseCron("*/0 * * * *")).toBeNull();
    expect(parseCron("a * * * *")).toBeNull();
  });
});

describe("nextCronRun", () => {
  it("finds the next quarter-hour slot", () => {
    const from = new Date("2026-01-01T00:00:00.000Z");
    expect(nextCronRun("*/15 * * * *", from)?.toISOString()).toBe("2026-01-01T00:15:00.000Z");
  });

  it("is strictly after `from` (a matching minute is not returned twice)", () => {
    const from = new Date("2026-01-01T00:15:00.000Z");
    expect(nextCronRun("*/15 * * * *", from)?.toISOString()).toBe("2026-01-01T00:30:00.000Z");
  });

  it("finds the next Monday 09:00 UTC", () => {
    // 2026-01-01 is a Thursday; the next Monday is 2026-01-05.
    const from = new Date("2026-01-01T00:00:00.000Z");
    expect(nextCronRun("0 9 * * 1", from)?.toISOString()).toBe("2026-01-05T09:00:00.000Z");
  });

  it("uses OR semantics when both day fields are restricted", () => {
    // Day 1 OR Monday: 2026-01-01 (Thu) matches the 1st even though it is not Monday.
    const from = new Date("2025-12-31T00:00:00.000Z");
    expect(nextCronRun("0 0 1 * 1", from)?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("returns null for a malformed expression", () => {
    expect(nextCronRun("nope", new Date())).toBeNull();
  });
});

describe("nextRunAt", () => {
  it("prefers the interval when set", () => {
    const from = new Date("2026-01-01T00:00:00.000Z");
    expect(nextRunAt({ cron: "0 0 1 1 *", intervalSeconds: 90 }, from)?.toISOString()).toBe("2026-01-01T00:01:30.000Z");
  });

  it("falls back to cron and returns null when neither is usable", () => {
    const from = new Date("2026-01-01T00:00:00.000Z");
    expect(nextRunAt({ cron: "*/15 * * * *", intervalSeconds: null }, from)?.toISOString()).toBe("2026-01-01T00:15:00.000Z");
    expect(nextRunAt({ cron: null, intervalSeconds: null }, from)).toBeNull();
    expect(nextRunAt({ cron: "", intervalSeconds: 0 }, from)).toBeNull();
  });
});
