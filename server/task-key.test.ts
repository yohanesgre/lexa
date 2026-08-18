import { describe, expect, it } from "vitest";
import { generateTaskKey, parseTaskKey } from "./task-key";

describe("generateTaskKey", () => {
  it("multi-word slug → word initials", () => {
    expect(generateTaskKey("emberfall-godot", () => false)).toBe("EG");
    expect(generateTaskKey("web-client", () => false)).toBe("WC");
    expect(generateTaskKey("project-management-tool", () => false)).toBe("PMT");
  });
  it("single word → first letter + consonants", () => {
    expect(generateTaskKey("platform", () => false)).toBe("PLT");
    expect(generateTaskKey("api", () => false)).toBe("AP");
    expect(generateTaskKey("web", () => false)).toBe("WB");
  });
  it("collision → extend with next letters of last word", () => {
    const taken = new Set(["WC"]);
    expect(generateTaskKey("web-crawler", (c) => taken.has(c))).toBe("WCR");
  });
  it("exhausted extension → digit suffix", () => {
    const taken = new Set(["PLT", "PLTL", "PLTLA", "PLTLAT", "PLTLATF", "PLTLATFO", "PLTLATFOR", "PLTLATFORM"]);
    expect(generateTaskKey("platform", (c) => taken.has(c))).toBe("PLT2");
  });
  it("digits in slug skipped for initials", () => {
    expect(generateTaskKey("game-jam-2026", () => false)).toBe("GJ");
  });
});

describe("parseTaskKey", () => {
  it("parses valid keys, case-insensitive", () => {
    expect(parseTaskKey("EMB-12")).toEqual({ prefix: "EMB", number: 12 });
    expect(parseTaskKey("emb-12")).toEqual({ prefix: "EMB", number: 12 });
  });
  it("rejects malformed", () => {
    expect(parseTaskKey("EMB-")).toBeNull();
    expect(parseTaskKey("EMB-abc")).toBeNull();
    expect(parseTaskKey("EMB-0")).toEqual({ prefix: "EMB", number: 0 });
    expect(parseTaskKey("a-1")).toBeNull();       // prefix too short
    expect(parseTaskKey("ABCDEFG-1")).toBeNull(); // prefix too long
    expect(parseTaskKey("t1")).toBeNull();        // UUID-ish, not a key
  });
});