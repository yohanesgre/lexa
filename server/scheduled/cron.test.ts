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
