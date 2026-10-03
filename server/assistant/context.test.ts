import { describe, expect, it } from "vitest";
import { buildSkillPromptParts, firstUserText, lastUserText, resolveMentionContext, type MentionResolverDeps } from "./context";
import { mentionSlug } from "../../shared/mention-entities";
import type { TipTapDoc } from "../../shared/types";
import type { BoundSkill } from "./tools";

function doc(text: string): TipTapDoc {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] } as TipTapDoc;
}

function skill(over: Partial<BoundSkill> & { name: string }): BoundSkill {
  return { description: null, instructions: null, ...over };
}

describe("buildSkillPromptParts", () => {
  it("renders ≤3 `$tokens` in mention order with a compact catalog", () => {
    const bound = [
      skill({ name: "Status Report", description: "rank work", instructions: "rank" }),
      skill({ name: "Review", description: null, instructions: "find defects" }),
    ];
    const { skillMarkdowns, skillCatalog } = buildSkillPromptParts("$status-report $review $missing", bound);
    expect(skillMarkdowns).toEqual(["## Skill: Status Report\nrank", "## Skill: Review\nfind defects"]);
    expect(skillCatalog).toBe(
      "Available skills — invoke with $name, or call get_skill for details:\n- Status Report — rank work\n- Review"
    );
  });

  it("caps at 3 markdowns, drops blank instructions, and counts overflow at 20", () => {
    const bound = Array.from({ length: 25 }, (_, i) =>
      skill({ name: `Skill ${i}`, description: `desc ${i}`, instructions: i === 0 ? "   " : `body ${i}` })
    );
    const { skillMarkdowns, skillCatalog } = buildSkillPromptParts("$Skill-1 $Skill-2 $Skill-3 $Skill-4", bound);
    expect(skillMarkdowns).toEqual(["## Skill: Skill 1\nbody 1", "## Skill: Skill 2\nbody 2", "## Skill: Skill 3\nbody 3"]);
    expect(skillCatalog).toContain("- Skill 0");
    expect(skillCatalog).toContain("… and 5 more");
  });

  it("returns a null catalog when the agent has nothing bound", () => {
    expect(buildSkillPromptParts("$anything", [])).toEqual({ skillMarkdowns: [], skillCatalog: null });
  });
});

describe("lastUserText", () => {
  it("returns the last user string content", () => {
    const messages = [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
    ];
    expect(lastUserText(messages)).toBe("second");
  });

  it("joins text parts of a UIMessage-shaped transcript", () => {
    const messages = [
      { role: "user", parts: [{ type: "text", text: "hello " }, { type: "text", text: "world" }] },
    ];
    expect(lastUserText(messages)).toBe("hello world");
  });

  it("returns empty when there is no user message", () => {
    expect(lastUserText([{ role: "assistant", content: "x" }])).toBe("");
    expect(lastUserText([])).toBe("");
  });
});

describe("firstUserText", () => {
  it("returns the first user string content, not the last", () => {
    const messages = [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
    ];
    expect(firstUserText(messages)).toBe("first");
  });

  it("joins text parts of a UIMessage-shaped transcript", () => {
    const messages = [
      { role: "user", parts: [{ type: "text", text: "hello " }, { type: "text", text: "world" }] },
    ];
    expect(firstUserText(messages)).toBe("hello world");
  });

  it("skips a leading textless user message so a later text turn seeds the title", () => {
    const messages = [
      { role: "user", parts: [{ type: "image-ref", storageKey: "k" }] },
      { role: "assistant", parts: [{ type: "text", text: "ack" }] },
      { role: "user", parts: [{ type: "text", text: "real question" }] },
    ];
    expect(firstUserText(messages)).toBe("real question");
  });

  it("returns empty when there is no user message", () => {
    expect(firstUserText([{ role: "assistant", content: "x" }])).toBe("");
    expect(firstUserText([])).toBe("");
  });
});

describe("resolveMentionContext", () => {
  function deps(over: Partial<MentionResolverDeps> = {}): MentionResolverDeps {
    return {
      dbAll: async () => [],
      findTaskByKey: async () => null,
      findWikiBySlug: async () => null,
      ...over,
    };
  }

  it("resolves a task token and renders the labeled block", async () => {
    const block = await resolveMentionContext(
      deps({
        findTaskByKey: async (key) =>
          key === "LX-1"
            ? { id: "t1", projectId: "p1", key: "LX-1", title: "Fix login", description: doc("Broken auth") }
            : null,
      }),
      "p1",
      "see @LX-1 please"
    );
    expect(block).toContain("- [task] LX-1 — Fix login");
    expect(block).toContain("Broken auth");
  });

  it("skips a task token whose task belongs to another project", async () => {
    const block = await resolveMentionContext(
      deps({
        findTaskByKey: async () => ({ id: "t1", projectId: "other", key: "LX-1", title: "X", description: doc("Y") }),
      }),
      "p1",
      "@LX-1"
    );
    expect(block).toBe("");
  });

  it("retries a wiki token lowercased when the exact slug misses", async () => {
    const seen: string[] = [];
    const block = await resolveMentionContext(
      deps({
        findWikiBySlug: async (_p, slug) => {
          seen.push(slug);
          return slug === "guide" ? { id: "w1", title: "Guide", content: doc("How to") } : null;
        },
      }),
      "p1",
      "@Guide"
    );
    expect(seen).toEqual(["Guide", "guide"]);
    expect(block).toContain("- [wiki] Guide");
    expect(block).toContain("How to");
  });

  it("matches milestone/swimlane/column by derived slug", async () => {
    const token = "q3-launch";
    expect(mentionSlug("Q3 Launch")).toBe(token);
    const block = await resolveMentionContext(
      deps({
        dbAll: async <T>(sql: string) => {
          if (sql.includes("FROM milestones")) {
            return [{ id: "m1", name: "Q3 Launch", due_at: null, archived_at: null, sprint_count: 1 }] as T[];
          }
          if (sql.includes("FROM swimlanes")) {
            return [{ id: "s1", name: "Q3 Launch", kind: "sprint", due_at: null, archived_at: null, milestone_id: "m1" }] as T[];
          }
          if (sql.includes("FROM columns")) {
            return [{ id: "c1", name: "Q3 Launch", position: 1, github_state: null, is_done: 0 }] as T[];
          }
          return [] as T[];
        },
      }),
      "p1",
      `@${token}`
    );
    expect(block).toContain("[milestone] Q3 Launch");
    expect(block).toContain("[swimlane] Q3 Launch");
    expect(block).toContain("[column] Q3 Launch");
  });

  it("is fail-open: a throwing lookup yields no hit and no throw", async () => {
    const block = await resolveMentionContext(
      deps({
        findTaskByKey: async () => {
          throw new Error("db down");
        },
        dbAll: async () => {
          throw new Error("db down");
        },
      }),
      "p1",
      "@LX-1 @Whatever"
    );
    expect(block).toBe("");
  });

  it("caps the block at MENTION_CAPS.maxMentions", async () => {
    const block = await resolveMentionContext(
      deps({
        findTaskByKey: async (key) => ({
          id: key,
          projectId: "p1",
          key,
          title: key,
          description: doc("text"),
        }),
      }),
      "p1",
      "@LX-1 @LX-2 @LX-3 @LX-4 @LX-5 @LX-6"
    );
    expect(block.match(/\[task\]/g)?.length).toBe(5);
  });
});
