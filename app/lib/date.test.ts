import { describe, expect, it } from "vitest";
import { parseApiDate } from "./date";

describe("parseApiDate", () => {
  it("treats SQLite datetime values as UTC", () => {
    expect(parseApiDate("2026-08-03 06:52:21").toISOString()).toBe("2026-08-03T06:52:21.000Z");
  });

  it("preserves timezone-aware ISO values", () => {
    expect(parseApiDate("2026-08-03T06:52:21.000Z").toISOString()).toBe("2026-08-03T06:52:21.000Z");
  });

  it("a T-separated value without an offset parses as UTC (no-offset forms are UTC)", () => {
    // The space-separated SQLite form gets a Z suffix; the T-form must behave
    // identically instead of falling into local-time parsing.
    expect(parseApiDate("2026-08-03T06:52:21").toISOString()).toBe("2026-08-03T06:52:21.000Z");
  });

  it("converts explicit offsets to the absolute instant", () => {
    expect(parseApiDate("2026-08-03T06:52:21+02:00").toISOString()).toBe("2026-08-03T04:52:21.000Z");
    expect(parseApiDate("2026-08-03T06:52:21-05:00").toISOString()).toBe("2026-08-03T11:52:21.000Z");
  });

  it("endsWith Z (no time part) is preserved", () => {
    expect(parseApiDate("2026-08-03Z").toISOString()).toBe("2026-08-03T00:00:00.000Z");
  });

  it("date-only values parse as midnight UTC (the appended Z makes them valid ISO)", () => {
    expect(parseApiDate("2026-08-03").toISOString()).toBe("2026-08-03T00:00:00.000Z");
  });

  it("empty string is Invalid Date", () => {
    const d = parseApiDate("");
    expect(Number.isNaN(d.getTime())).toBe(true);
  });
});
