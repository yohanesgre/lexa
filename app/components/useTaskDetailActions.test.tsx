// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useTaskDetailActions } from "./useTaskDetailActions";

const emptyDoc = { type: "doc", content: [] } as const;

function baseArgs(overrides: Record<string, unknown> = {}) {
  const onCreate = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  return {
    args: {
      task: null,
      defaultColumnId: "c1",
      defaultSwimlaneId: "s1",
      columns: [{ id: "c1" }, { id: "c2" }],
      fieldConfig: { priorities: [{ id: "pr1" }], types: [{ id: "tp1" }] },
      emptyDoc,
      onCreate,
      onClose,
      ...overrides,
    },
    onCreate,
    onClose,
  };
}

describe("useTaskDetailActions create swimlane", () => {
  afterEach(() => vi.clearAllMocks());

  it("defaults the swimlane and sends it on create", async () => {
    const { args, onCreate } = baseArgs();
    const { result } = renderHook(() => useTaskDetailActions(args as never));

    expect(result.current.createSwimlaneId).toBe("s1");
    expect(result.current.createColumnId).toBe("c1");

    act(() => result.current.setCreateTitle("Warm-up before boss fight"));
    await act(async () => {
      await result.current.handleCreate();
    });

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Warm-up before boss fight", columnId: "c1", swimlaneId: "s1" }),
    );
  });

  it("omits the swimlane when the host does not opt in", async () => {
    const { args, onCreate } = baseArgs({ defaultSwimlaneId: undefined });
    const { result } = renderHook(() => useTaskDetailActions(args as never));

    expect(result.current.createSwimlaneId).toBe("");
    act(() => result.current.setCreateTitle("No lane"));
    await act(async () => {
      await result.current.handleCreate();
    });

    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ swimlaneId: undefined }));
  });
});

describe("useTaskDetailActions required-field gate", () => {
  afterEach(() => vi.clearAllMocks());

  it("does not create when a required description is empty (Enter path)", async () => {
    const { args, onCreate } = baseArgs({ columnRequiredFields: [{ columnId: "c1", fields: ["description"] }] });
    const { result } = renderHook(() => useTaskDetailActions(args as never));

    act(() => result.current.setCreateTitle("Needs a body"));
    await act(async () => {
      await result.current.handleCreate();
    });

    expect(onCreate).not.toHaveBeenCalled();
  });

  it("does not create when a required description is whitespace-only", async () => {
    const { args, onCreate } = baseArgs({ columnRequiredFields: [{ columnId: "c1", fields: ["description"] }] });
    const { result } = renderHook(() => useTaskDetailActions(args as never));

    act(() => result.current.setCreateTitle("Needs a body"));
    act(() =>
      result.current.setCreateDescription({
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "   " }] }],
      })
    );
    await act(async () => {
      await result.current.handleCreate();
    });

    expect(onCreate).not.toHaveBeenCalled();
  });

  it("creates once the required fields are satisfied", async () => {
    const { args, onCreate } = baseArgs({ columnRequiredFields: [{ columnId: "c1", fields: ["assignee", "description"] }] });
    const { result } = renderHook(() => useTaskDetailActions(args as never));

    act(() => result.current.setCreateTitle("Ready"));
    act(() => result.current.setCreateAssignees(["Ada"]));
    act(() =>
      result.current.setCreateDescription({
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Body" }] }],
      })
    );
    await act(async () => {
      await result.current.handleCreate();
    });

    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ title: "Ready", columnId: "c1" }));
  });
});
