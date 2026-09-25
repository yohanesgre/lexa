import { describe, it, expect } from "vitest";
import { workersClientIp } from "./http";

// The Workers path has no socket IP, so `cf-connecting-ip` is the only source.
// An inbound `x-lexa-remote-ip` (never stamped on this path) must be deleted
// before reading, or a client could pin its own rate-limit bucket.
describe("workersClientIp", () => {
  it("ignores an inbound x-lexa-remote-ip and uses cf-connecting-ip", () => {
    expect(workersClientIp({ "x-lexa-remote-ip": "10.0.0.5", "cf-connecting-ip": "203.0.113.7" })).toBe("203.0.113.7");
  });

  it("falls back to unknown when only a spoofed stamp is present", () => {
    expect(workersClientIp({ "x-lexa-remote-ip": "127.0.0.1" })).toBe("unknown");
  });

  it("returns unknown with no headers", () => {
    expect(workersClientIp({})).toBe("unknown");
  });
});
