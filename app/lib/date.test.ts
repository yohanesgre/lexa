import { describe, expect, it } from "vitest";
import { parseApiDate } from "./date";

describe("parseApiDate", () => {
  it("treats SQLite datetime values as UTC", () => {
    expect(parseApiDate("2026-08-03 06:52:21").toISOString()).toBe("2026-08-03T06:52:21.000Z");
  });

  it("preserves timezone-aware ISO values", () => {
    expect(parseApiDate("2026-08-03T06:52:21.000Z").toISOString()).toBe("2026-08-03T06:52:21.000Z");
  });
});
