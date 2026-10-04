import { describe, expect, it } from "vitest";
import { runDocumentTarget, runKindLabel } from "./run-display";

describe("runKindLabel", () => {
  it("labels schedule rows", () => {
    expect(runKindLabel({ kind: "schedule" })).toBe("Schedule");
  });

  it("labels chat runs, even when a document type is present", () => {
    expect(runKindLabel({ kind: "chat_run", documentType: "wiki" })).toBe("Chat");
  });

  it("labels task documents", () => {
    expect(runKindLabel({ documentType: "task" })).toBe("Task");
  });

  it("labels wiki documents", () => {
    expect(runKindLabel({ documentType: "wiki" })).toBe("Wiki");
  });

  it("falls back to Chat for document rows without a type", () => {
    expect(runKindLabel({ kind: "document" })).toBe("Chat");
    expect(runKindLabel({})).toBe("Chat");
  });
});

describe("runDocumentTarget", () => {
  it("links a task by ticket key", () => {
    expect(runDocumentTarget({ documentType: "task", documentId: "t1", key: "LX-1" })).toEqual({ kind: "task", value: "LX-1" });
  });

  it("falls back to the task id when the key is blank", () => {
    expect(runDocumentTarget({ documentType: "task", documentId: "t1", key: "" })).toEqual({ kind: "task", value: "t1" });
  });

  it("links a wiki page by document id, never the key", () => {
    expect(runDocumentTarget({ documentType: "wiki", documentId: "w1", key: "LX-1" })).toEqual({ kind: "wiki", value: "w1" });
  });

  it("returns null for chat/schedule rows with no document", () => {
    expect(runDocumentTarget({ documentType: null, documentId: "x", key: "LX-1" })).toBeNull();
  });

  it("returns null when the document id is blank", () => {
    expect(runDocumentTarget({ documentType: "task", documentId: "   ", key: "LX-1" })).toBeNull();
  });
});
