import { describe, expect, it } from "vitest";
import { parseDateOnly, formatDueLabel } from "./dates";

describe("parseDateOnly", () => {
  it("parses YYYY-MM-DD as a local calendar date", () => {
    const d = parseDateOnly("2026-08-03");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(7); // zero-based
    expect(d.getDate()).toBe(3);
  });

  it("handles zero-padded months and days", () => {
    const d = parseDateOnly("2026-01-01");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(1);
  });
});

describe("formatDueLabel", () => {
  const today = new Date(2026, 5, 15); // 2026-06-15 local

  it("flags overdue dates with the day count", () => {
    expect(formatDueLabel("2026-06-10", today)).toEqual({ text: "Overdue 5d", overdue: true });
    expect(formatDueLabel("2026-06-14", today)).toEqual({ text: "Overdue 1d", overdue: true });
  });

  it("due today", () => {
    expect(formatDueLabel("2026-06-15", today)).toEqual({ text: "Due today", overdue: false });
  });

  it("due tomorrow shows the weekday only", () => {
    // 2026-06-16 is a Tuesday.
    expect(formatDueLabel("2026-06-16", today)).toEqual({ text: "Due Tue", overdue: false });
  });

  it("further out shows the weekday and the day count", () => {
    // 2026-06-20 is a Saturday.
    expect(formatDueLabel("2026-06-20", today)).toEqual({ text: "Due Sat · 5d left", overdue: false });
  });
});
