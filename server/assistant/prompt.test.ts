import { describe, expect, it } from "vitest";
import { buildSystemPrompts, type SystemPromptInput } from "./prompt";

const base: SystemPromptInput = {
  identity: "IDENTITY",
  memoryBlock: null,
  agentMarkdown: null,
  skillMarkdown: null,
};

const advisory = "Jev advisory (non-authoritative)\n- write intent: write (confidence 0.72)";

describe("buildSystemPrompts advisory block", () => {
  it("rides in the last, uncached context slot next to the other context blocks", () => {
    const prompts = buildSystemPrompts({ ...base, docContext: "DOC", mentionContext: "MENTION", advisory });
    expect(prompts).toHaveLength(3);
    const last = prompts[2]!;
    expect(last.cache_control).toBeUndefined();
    expect(last.content).toContain("DOC");
    expect(last.content).toContain("MENTION");
    expect(last.content).toContain(advisory);
  });

  it("leaves the cached slots byte-identical with and without an advisory", () => {
    const without = buildSystemPrompts({ ...base, memoryBlock: "MEM", agentMarkdown: "AGENT", docContext: "DOC" });
    const withAdvisory = buildSystemPrompts({
      ...base,
      memoryBlock: "MEM",
      agentMarkdown: "AGENT",
      docContext: "DOC",
      advisory,
    });
    expect(withAdvisory[0]!.content).toBe(without[0]!.content);
    expect(withAdvisory[1]!.content).toBe(without[1]!.content);
    expect(withAdvisory[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(withAdvisory[1]!.cache_control).toEqual({ type: "ephemeral" });
    // The uncached slot keeps its pre-advisory prefix, so the advisory is pure
    // addition.
    expect(withAdvisory[2]!.content.startsWith(without[2]!.content)).toBe(true);
  });

  it("emits nothing extra for an absent, null, or blank advisory", () => {
    const plain = buildSystemPrompts({ ...base, docContext: "DOC" });
    for (const value of [undefined, null, "", "   ", "\n\t "]) {
      const prompts = buildSystemPrompts({ ...base, docContext: "DOC", advisory: value });
      expect(prompts.length, JSON.stringify(value)).toBe(plain.length);
      expect(prompts[2]!.content).toBe(plain[2]!.content);
    }
  });

  it("carries an advisory on its own when no other context block exists", () => {
    const prompts = buildSystemPrompts({ ...base, advisory });
    expect(prompts).toHaveLength(3);
    expect(prompts[2]!.content).toBe(advisory);
    expect(prompts[2]!.cache_control).toBeUndefined();
  });
});
