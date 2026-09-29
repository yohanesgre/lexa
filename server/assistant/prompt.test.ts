import { describe, expect, it } from "vitest";
import { buildSystemPrompts, type SystemPromptInput } from "./prompt";

const base: SystemPromptInput = {
  identity: "IDENTITY",
  memoryBlock: null,
  agentMarkdown: null,
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

describe("buildSystemPrompts skills", () => {
  it("joins agent + skill markdowns in order in the cached rules slot", () => {
    const prompts = buildSystemPrompts({
      ...base,
      agentMarkdown: "AGENT",
      skillMarkdowns: ["## Skill: Status\nrank work", "## Skill: Review\nfind defects"],
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!.content).toBe("AGENT\n\n## Skill: Status\nrank work\n\n## Skill: Review\nfind defects");
    expect(prompts[1]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("drops blank skill markdowns; absent skills keep the default rules copy", () => {
    const blank = buildSystemPrompts({ ...base, agentMarkdown: "AGENT", skillMarkdowns: ["  ", ""] });
    expect(blank[1]!.content).toBe("AGENT");
    expect(buildSystemPrompts(base)[1]!.content).toBe(
      "No additional behavior rules are active. Use your default judgment."
    );
  });

  it("rides the catalog in the cached identity segment, after the write policy", () => {
    const catalog = "Available skills — invoke with $name, or call get_skill for details:\n- Status — rank work";
    const withCatalog = buildSystemPrompts({ ...base, writeTools: ["create_task"], skillCatalog: catalog });
    const withoutCatalog = buildSystemPrompts({ ...base, writeTools: ["create_task"] });
    expect(withCatalog[0]!.content.endsWith(catalog)).toBe(true);
    expect(withCatalog[0]!.content.startsWith(withoutCatalog[0]!.content)).toBe(true);
    expect(withCatalog[0]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("emits no catalog segment for null or blank catalogs", () => {
    const plain = buildSystemPrompts(base);
    for (const value of [null, "", "   "] as (string | null)[]) {
      expect(buildSystemPrompts({ ...base, skillCatalog: value })[0]!.content).toBe(plain[0]!.content);
    }
  });
});
