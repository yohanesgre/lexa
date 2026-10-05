// Pure helpers for the assistant editor panel: every run target is the single
// builtin assistant agent, and auto skill selection carries NO skillId.
import { describe, it, expect } from "vitest";
import { buildRunRequest, resolveRunSelection } from "./assistant-panel-utils";

describe("buildRunRequest", () => {
  it("targets the assistant agent, trims the prompt, and omits skillId in auto mode", () => {
    const req = buildRunRequest({ slug: "demo", documentType: "task", documentId: "t1", prompt: "  hi  ", selection: "", docImages: [] });
    expect(req).toMatchObject({ slug: "demo", agentId: "assistant", prompt: "hi" });
    expect(req).not.toHaveProperty("skillId");
    expect(req).not.toHaveProperty("selection");
    expect(req).not.toHaveProperty("attachments");
  });

  it("carries a non-empty selection and doc image attachments", () => {
    const req = buildRunRequest({
      slug: "demo", documentType: "wiki", documentId: "w1", prompt: "go", selection: "some text",
      docImages: [{ id: "a1", filename: "x.png", mimeType: "image/png", sha256: "abc" } as never],
    });
    expect(req.selection).toBe("some text");
    expect(req.attachments).toEqual([{ storageKey: "blobs/abc", mimeType: "image/png", name: "x.png" }]);
  });
});

describe("resolveRunSelection", () => {
  it("sends no Selected-text instruction when nothing is selected", () => {
    expect(resolveRunSelection({ markdown: "" })).toBe("");
    const req = buildRunRequest({ slug: "demo", documentType: "task", documentId: "t1", prompt: "", selection: resolveRunSelection({ markdown: "" }), docImages: [] });
    expect(req).not.toHaveProperty("selection");
  });

  it("passes the selection markdown through when text is selected", () => {
    expect(resolveRunSelection({ markdown: "**bold**" })).toBe("**bold**");
  });
});
