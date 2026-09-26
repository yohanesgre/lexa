// Pure helpers for the assistant editor panel: the single builtin agent gates
// skill availability and every run request (asserting the agent-runtime tier
// is gone).
import { describe, it, expect } from "vitest";
import { buildRunRequest, pickAssistantSkill } from "./assistant-panel-utils";
import type { LexaAgent, LexaSkill } from "../../../../shared/types";

const agent = (id: string, skillIds: string[]): LexaAgent => ({
  id, name: id, description: "", instructions: "", isBuiltin: true, skillIds, createdAt: "t", updatedAt: "t",
});
const skill = (id: string, name: string): LexaSkill => ({
  id, name, description: "", instructions: "", isBuiltin: true, createdAt: "t", updatedAt: "t",
});

describe("pickAssistantSkill", () => {
  it("filters to the assistant agent's junction rows and falls back to the first", () => {
    const picked = pickAssistantSkill([agent("assistant", ["s1"])], [skill("s1", "Polish"), skill("s2", "Other")], "");
    expect(picked.agentSkills.map((s) => s.id)).toEqual(["s1"]);
    expect(picked.effectiveSkillId).toBe("s1");
    expect(picked.skillName).toBe("Polish");
  });

  it("ignores an out-of-junction selected id", () => {
    const picked = pickAssistantSkill([agent("assistant", ["s1"])], [skill("s1", "Polish"), skill("s2", "Other")], "s2");
    expect(picked.effectiveSkillId).toBe("s1");
  });
});

describe("buildRunRequest", () => {
  it("always targets the assistant agent and trims the prompt", () => {
    const req = buildRunRequest({ slug: "demo", documentType: "task", documentId: "t1", prompt: "  hi  ", skillId: "s1", selection: "", docImages: [] });
    expect(req).toMatchObject({ slug: "demo", agentId: "assistant", skillId: "s1", prompt: "hi" });
    expect(req).not.toHaveProperty("selection");
    expect(req).not.toHaveProperty("attachments");
  });

  it("carries a non-empty selection and doc image attachments", () => {
    const req = buildRunRequest({
      slug: "demo", documentType: "wiki", documentId: "w1", prompt: "go", skillId: "s1", selection: "some text",
      docImages: [{ id: "a1", filename: "x.png", mimeType: "image/png", sha256: "abc" } as never],
    });
    expect(req.selection).toBe("some text");
    expect(req.attachments).toEqual([{ storageKey: "blobs/abc", mimeType: "image/png", name: "x.png" }]);
  });
});
