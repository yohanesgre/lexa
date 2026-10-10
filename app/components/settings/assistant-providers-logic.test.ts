import { describe, expect, it } from "vitest";
import { activePreset, PROVIDER_PRESETS } from "./assistant-providers-logic";

// Provider quick-fill presets (wireframe admin-assistant-providers.html): they
// write Label + Base URL only; the active mark is derived from an exact pair
// match, so editing either field clears it.
describe("provider presets", () => {
  it("exposes the three presets with exact label + base URL pairs", () => {
    expect(PROVIDER_PRESETS.map((p) => [p.label, p.baseUrl])).toEqual([
      ["Cloudflare AI", "https://api.cloudflare.com/client/v4/accounts/<account_id>/ai/v1"],
      ["OpenCode Zen", "https://opencode.ai/zen/v1"],
      ["OpenCode Go", "https://opencode.ai/zen/go/v1"],
    ]);
  });

  it("marks a preset active only while both fields match exactly", () => {
    expect(activePreset("OpenCode Zen", "https://opencode.ai/zen/v1")?.label).toBe("OpenCode Zen");
    expect(activePreset("Cloudflare AI", "https://api.cloudflare.com/client/v4/accounts/<account_id>/ai/v1")?.label).toBe("Cloudflare AI");
    // editing either field clears the mark
    expect(activePreset("OpenCode Zen", "https://opencode.ai/zen/go/v1")).toBeNull();
    expect(activePreset("Renamed", "https://opencode.ai/zen/v1")).toBeNull();
    expect(activePreset("", "")).toBeNull();
  });
});
