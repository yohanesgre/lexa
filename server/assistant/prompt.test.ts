import { describe, expect, it } from "vitest";
import { buildSystemPrompts, CHAT_SKILL_INSTRUCTION, MARKDOWN_STYLE, WRITE_POLICY, type SystemPromptInput } from "./prompt";

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
});

describe("buildSystemPrompts semantic hint", () => {
  it("emits nothing when absent, null, or blank — the array stays byte-identical", () => {
    const baseline = buildSystemPrompts({ ...base, memoryBlock: "MEM", agentMarkdown: "AGENT", docContext: "DOC", advisory });
    const absent = buildSystemPrompts({ ...base, memoryBlock: "MEM", agentMarkdown: "AGENT", docContext: "DOC", advisory, semanticHint: null });
    const blank = buildSystemPrompts({ ...base, memoryBlock: "MEM", agentMarkdown: "AGENT", docContext: "DOC", advisory, semanticHint: "   " });
    expect(absent.map((p) => p.content)).toEqual(baseline.map((p) => p.content));
    expect(blank.map((p) => p.content)).toEqual(baseline.map((p) => p.content));
    expect(absent[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(absent[1]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("rides after advisory and before the thread summary in the uncached slot", () => {
    const hint = "[Possibly relevant — auto-retrieved from project content; not authoritative]\nRelease checklist (wiki): Ship on Friday.";
    const prompts = buildSystemPrompts({
      ...base,
      memoryBlock: "MEM",
      agentMarkdown: "AGENT",
      docContext: "DOC",
      advisory,
      semanticHint: hint,
      threadSummary: { summary: "SUMMARY", summarizedCount: 3 },
    });
    expect(prompts).toHaveLength(3);
    const last = prompts[2]!;
    expect(last.cache_control).toBeUndefined();
    expect(last.content).toContain(hint);
    expect(last.content.indexOf(advisory)).toBeLessThan(last.content.indexOf(hint));
    expect(last.content.indexOf(hint)).toBeLessThan(last.content.indexOf("[Conversation summary"));
    // Cached slots untouched by the per-turn hint.
    expect(prompts[0]!.content).not.toContain(hint);
    expect(prompts[1]!.content).not.toContain(hint);
  });
});

describe("buildSystemPrompts thread summary", () => {
  it("leaves the cached slots byte-identical with and without a summary", () => {
    const without = buildSystemPrompts({ ...base, memoryBlock: "MEM", agentMarkdown: "AGENT", docContext: "DOC" });
    const withSummary = buildSystemPrompts({
      ...base,
      memoryBlock: "MEM",
      agentMarkdown: "AGENT",
      docContext: "DOC",
      threadSummary: { summary: "s", summarizedCount: 2 },
    });
    expect(withSummary[0]!.content).toBe(without[0]!.content);
    expect(withSummary[1]!.content).toBe(without[1]!.content);
    expect(withSummary[2]!.content.startsWith(without[2]!.content)).toBe(true);
  });

  it("keeps the fixed segment order with every block present", () => {
    const prompts = buildSystemPrompts({
      identity: "IDENTITY",
      memoryBlock: "MEM",
      agentMarkdown: "AGENT",
      skillMarkdowns: ["SKILL"],
      skillCatalog: "CATALOG",
      writeTools: ["create_task"],
      repoContent: [{ owner: "o", repo: "o/r", path: "a.ts", content: "SRC" }],
      docContext: "DOC",
      mentionContext: "MENTION",
      advisory: "ADV",
      threadSummary: { summary: "SUMMARY", summarizedCount: 7 },
    });
    expect(prompts).toHaveLength(3);
    expect(prompts[0]!.content).toBe(`IDENTITY\n\n${MARKDOWN_STYLE}\n\nMEM\n\n${WRITE_POLICY}\n\nCATALOG`);
    expect(prompts[1]!.content).toBe("AGENT\n\nSKILL");
    const last = prompts[2]!;
    expect(last.content.indexOf("SRC")).toBeLessThan(last.content.indexOf("DOC"));
    expect(last.content.indexOf("DOC")).toBeLessThan(last.content.indexOf("MENTION"));
    expect(last.content.indexOf("MENTION")).toBeLessThan(last.content.indexOf("ADV"));
    expect(last.content.indexOf("ADV")).toBeLessThan(last.content.indexOf("[Conversation summary"));

    // A non-document turn with no skills emits the neutral fallback, not the
    // document-only instruction.
    expect(buildSystemPrompts(base)[1]!.content).toBe(CHAT_SKILL_INSTRUCTION);
    expect(buildSystemPrompts({ ...base, autoSkill: false })[1]!.content).toBe(CHAT_SKILL_INSTRUCTION);
    expect(CHAT_SKILL_INSTRUCTION).toBe("No additional behavior rules are active. Use your default judgment.");
    expect(CHAT_SKILL_INSTRUCTION).not.toContain("Additional prompt");
    expect(CHAT_SKILL_INSTRUCTION).not.toContain("catalog");
  });
});
