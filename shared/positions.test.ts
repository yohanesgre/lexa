import { describe, expect, it } from "vitest";
import { keyAfter, keyBetween } from "./positions";

describe("positions keyAfter", () => {
  it("generates the first key for an empty column (null last)", () => {
    expect(keyAfter(null)).toBe("a0");
    // Deterministic: same input, same key.
    expect(keyAfter(null)).toBe(keyAfter(null));
  });

  it("appends after the last key, preserving strict order", () => {
    const k1 = keyAfter(null); // a0
    const k2 = keyAfter(k1);
    const k3 = keyAfter(k2);
    expect(k1).toBe("a0");
    expect(k2).toBe("a1");
    expect(k3).toBe("a2");
    expect(k1 < k2).toBe(true);
    expect(k2 < k3).toBe(true);
    // Appending to a non-empty column must never regenerate the first key.
    expect(k2).not.toBe("a0");
  });
});

describe("positions keyBetween", () => {
  it("inserts between two non-adjacent keys", () => {
    expect(keyBetween("a0", "a2")).toBe("a1");
    expect("a0" < keyBetween("a0", "a2")).toBe(true);
    expect(keyBetween("a0", "a2") < "a2").toBe(true);
  });

  it("inserts between dense neighbors without colliding", () => {
    const k = keyBetween("a0", "a1");
    expect(k).toBe("a0V");
    expect("a0" < k).toBe(true);
    expect(k < "a1").toBe(true);
  });

  it("inserts at the head with a null lower anchor", () => {
    const k = keyBetween(null, "a0");
    expect(k).toBe("Zz");
    expect(k < "a0").toBe(true);
  });

  it("appends with a null upper anchor", () => {
    expect(keyBetween("a0", null)).toBe("a1");
    expect("a0" < keyBetween("a0", null)).toBe(true);
  });

  it("with both anchors null generates the canonical first key", () => {
    expect(keyBetween(null, null)).toBe("a0");
    expect(keyBetween(null, null)).toBe(keyAfter(null));
  });

  it("keeps a chain of dense insertions strictly ordered", () => {
    // Build a dense run: a0 → a1, then squeeze keys between them.
    const a = "a0";
    const b = "a1";
    const mid = keyBetween(a, b); // a0V
    const mid2 = keyBetween(a, mid); // between a0 and a0V
    expect(a < mid2).toBe(true);
    expect(mid2 < mid).toBe(true);
    expect(mid < b).toBe(true);
  });
});

describe("positions documented invariant", () => {
  it("keyBetween(null, null) always returns a0 — appending into a non-empty column with a null anchor would collide", () => {
    // The caller contract: neighborless moves pass the CURRENT last key to
    // keyAfter; generateKeyBetween(null, null) is only legal for an empty
    // column because it regenerates the canonical first key 'a0'.
    const first = keyAfter(null);
    expect(first).toBe("a0");
    const second = keyAfter(first);
    expect(second).not.toBe(first);
    // Re-anchoring with null into the non-empty column would duplicate 'a0'.
    expect(keyAfter(null)).toBe(first);
  });
});
