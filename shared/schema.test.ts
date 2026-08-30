import { describe, expect, it } from "vitest";
import { decodeBoard, decodeTask, isTipTapEmpty } from "./schema";
import type { Board, Task, TipTapDoc } from "./types";

const validBoard: Board = {
  project: { id: "p1", name: "Demo", slug: "demo", key: "DEM", description: "", repos: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
  columns: [{ id: "c1", projectId: "p1", name: "Todo", position: 0, color: "#fff", wipLimit: null, requiredFields: [], githubState: null, isDone: false }],
  swimlanes: [{ id: "s1", projectId: "p1", name: "Backlog", description: "", position: 0, dueAt: null, archivedAt: null, startAt: null, kind: "backlog", milestoneId: null }],
  milestones: [],
  fieldConfig: { priorities: [], types: [] },
  links: [],
  tasks: [
    {
      id: "t1",
      key: "DEM-1",
      projectId: "p1",
      columnId: "c1",
      swimlaneId: "s1",
      title: "Hello",
      description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] },
      priority: "prio-1",
      type: "type-1",
      assignees: [],
      position: "a0",
      githubs: [],
      dueAt: null,
      archivedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
};

const validTask: Task = validBoard.tasks[0]!;

describe("decodeBoard", () => {
  it("passes for valid board", () => {
    expect(() => decodeBoard(validBoard)).not.toThrow();
    const decoded = decodeBoard(validBoard);
    expect(decoded.project.slug).toBe("demo");
  });
  it("throws for invalid board (missing project)", () => {
    expect(() => decodeBoard({ ...validBoard, project: null as unknown as Board["project"] })).toThrow();
  });
  it("throws for invalid task inside board (bad description type)", () => {
    const bad = { ...validBoard, tasks: [{ ...validTask, description: { type: "doc", content: "bad" as unknown as [] } }] };
    expect(() => decodeBoard(bad)).toThrow();
  });
});

describe("decodeTask", () => {
  it("passes for valid task", () => {
    expect(() => decodeTask(validTask)).not.toThrow();
  });
  it("throws for invalid task", () => {
    expect(() => decodeTask({ ...validTask, title: 123 as unknown as string })).toThrow();
  });
});

describe("isTipTapEmpty", () => {
  it("empty doc content []", () => {
    expect(isTipTapEmpty({ type: "doc", content: [] })).toBe(true);
  });
  it("paragraph with empty content", () => {
    const doc: TipTapDoc = { type: "doc", content: [{ type: "paragraph", content: [] }] };
    expect(isTipTapEmpty(doc)).toBe(true);
  });
  it("paragraph with whitespace text", () => {
    const doc: TipTapDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "   " }] }] };
    expect(isTipTapEmpty(doc)).toBe(true);
  });
  it("mention-only => empty", () => {
    const doc: TipTapDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: "u1", label: "Alice" } }] }] };
    expect(isTipTapEmpty(doc)).toBe(true);
  });
  it("image-only => empty", () => {
    const doc: TipTapDoc = { type: "doc", content: [{ type: "image", attrs: { src: "/api/attachments/00000000-0000-4000-a000-000000000000" } }] };
    expect(isTipTapEmpty(doc)).toBe(true);
  });
  it("false with text hi", () => {
    const doc: TipTapDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] };
    expect(isTipTapEmpty(doc)).toBe(false);
  });
  it("false with nested text hi", () => {
    const doc: TipTapDoc = { type: "doc", content: [{ type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] }] };
    expect(isTipTapEmpty(doc)).toBe(false);
  });
});
