import { describe, expect, it } from "vitest";
import { OPTION_COLORS } from "./option-colors";

describe("OPTION_COLORS", () => {
  it("contains only canonical phosphor + warm-gray hexes", () => {
    const canonical = new Set([
      "#F0C040", "#8A7020", "#4ADE80", "#2D7A4A", "#22D3EE", "#1A6B7A",
      "#FF4444", "#8A2020", "#F472B6", "#8A4068", "#6B6560", "#B8B2AB", "#E8E4DE",
    ]);
    for (const c of OPTION_COLORS) expect(canonical.has(c.value)).toBe(true);
  });
  it("has unique labels", () => {
    const labels = OPTION_COLORS.map((c) => c.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
