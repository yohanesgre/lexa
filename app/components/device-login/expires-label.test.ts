import { describe, expect, it } from "vitest";
import { expiresInLabel } from "./expires-label";

describe("expiresInLabel", () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");

  it("reports minutes remaining", () => {
    expect(expiresInLabel("2026-01-01T00:10:00.000Z", now)).toBe("expires in 10 min");
  });

  it("never rounds a live request below one minute", () => {
    expect(expiresInLabel("2026-01-01T00:00:30.000Z", now)).toBe("expires in 1 min");
  });

  it("transitions to expired once the deadline passes", () => {
    expect(expiresInLabel("2026-01-01T00:00:00.000Z", now)).toBe("expired");
    expect(expiresInLabel("2025-12-31T23:59:00.000Z", now)).toBe("expired");
  });
});
