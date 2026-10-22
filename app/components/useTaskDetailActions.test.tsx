// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { useTaskDetailActions } from "./useTaskDetailActions";

vi.mock("./DescriptionEditor", () => {
  function MockDescriptionEditor({ initialContent, onDone, onChange, onCancel }: {
    initialContent: string;
    onDone?: (source: string) => void | Promise<void>;
    onChange?: (source: string) => void;
    onCancel?: () => void;
  }) {
    const [source, setSource] = useState(initialContent);
    return (
      <>
        <textarea
          aria-label="Description source"
          value={source}
          onChange={(event) => {
            setSource(event.target.value);
            onChange?.(event.target.value);
          }}
        />
        <button type="button" onClick={() => void onDone?.(source)}>Save editor</button>
        <button type="button" onClick={onCancel}>Revert editor</button>
      </>
    );
  }
  return { DescriptionEditor: MockDescriptionEditor };
});
vi.mock("./MarkdownContent", () => ({ MarkdownContent: () => null }));
vi.mock("./document/LinksSection", () => ({ LinksSection: () => null }));
vi.mock("./document/SourcesSection", () => ({ SourcesSection: () => null }));

import { TaskDescriptionSection } from "./TaskDescriptionSection";
vi.mock("./editor/MarkdownEditorPane", () => ({
  MarkdownEditorPane: ({ value, onChange, onEnter, onEscape, ariaLabel }: {
    value: string;
    onChange: (source: string) => void;
    onEnter?: () => void;
    onEscape?: () => void;
    ariaLabel: string;
  }) => (
    <textarea
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          onEnter?.();
        }
        if (event.key === "Escape") onEscape?.();
      }}
    />
  ),
}));

import type { TaskComment } from "../../shared/types";
import { CommentCard } from "./activity/CommentCard";


describe("task creation required-field flow", () => {
  it("keeps an incomplete draft open and creates after meaningful Markdown and an assignee are supplied", async () => {
    let created = 0;
    let closed = 0;
    const args: Parameters<typeof useTaskDetailActions>[0] = {
      task: null,
      defaultColumnId: "c1",
      columns: [{ id: "c1" }],
      fieldConfig: { priorities: [{ id: "pr1" }], types: [{ id: "tp1" }] },
      columnRequiredFields: [{ columnId: "c1", fields: ["assignee", "description"] }],
      emptyContent: "",
      onCreate: async () => { created += 1; },
      onClose: () => { closed += 1; },
    };
    const { result } = renderHook(() => useTaskDetailActions(args));

    act(() => result.current.setCreateTitle("Ready"));
    await act(async () => { await result.current.handleCreate(); });
    expect(created).toBe(0);
    expect(closed).toBe(0);

    act(() => {
      result.current.setCreateAssignees(["Ada"]);
      result.current.setCreateDescription(" \n\t");
    });
    await act(async () => { await result.current.handleCreate(); });
    expect(created).toBe(0);
    expect(closed).toBe(0);

    act(() => result.current.setCreateDescription("# Body\n\n- [x] ready"));
    await act(async () => { await result.current.handleCreate(); });
    expect(created).toBe(1);
    expect(closed).toBe(1);
    expect(result.current.creating).toBe(false);
  });
});
describe("comment editor pending-save edits", () => {
  it("keeps edits typed after submitted comment snapshot resolves", async () => {
    let resolveUpdate!: () => void;
    const update = vi.fn(() => new Promise<void>((resolve) => { resolveUpdate = resolve; }));
    const comment: TaskComment = {
      id: 4,
      taskId: "task-a",
      authorId: "user-a",
      authorKind: "user",
      authorLabel: "Ada",
      body: "stored body",
      viaAssistant: false,
      editedAt: null,
      deletedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    render(
      <CommentCard
        comment={comment}
        members={[]}
        currentUser={{ id: "user-a", email: null, name: "Ada", role: "member" }}
        onDelete={() => {}}
        onUpdate={update}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit comment" }));
    const editor = screen.getByRole("textbox", { name: "Edit comment" });
    fireEvent.change(editor, { target: { value: "submitted body" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    fireEvent.change(editor, { target: { value: "later edit" } });
    await act(async () => resolveUpdate());

    expect(screen.getByRole("textbox", { name: "Edit comment" })).toHaveValue("later edit");
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });
});
describe("task description save ownership", () => {
  it("serializes task saves across editor unmounts so the latest source commits last", async () => {
    let persisted = "";
    const requests: { source: string; resolve: () => void }[] = [];
    const save = vi.fn((_id: string, data: { description: string }) =>
      new Promise<void>((resolve) => {
        requests.push({
          source: data.description,
          resolve: () => {
            persisted = data.description;
            resolve();
          },
        });
      }),
    );
    const task = { id: "task-a", description: "initial" };
    function Harness() {
      const [editing, setEditing] = useState(true);
      return (
        <TaskDescriptionSection
          isCreate={false}
          slug="demo"
          task={task}
          emptyContent=""
          taskTitles={undefined}
          taskKeys={undefined}
          editingDescription={editing}
          setEditingDescription={setEditing}
          setCreateDescription={() => {}}
          onSaveDescription={save}
        />
      );
    }

    const firstEditor = render(<Harness />);
    const source = screen.getByRole("textbox", { name: "Description source" });
    fireEvent.change(source, { target: { value: "first source" } });
    fireEvent.click(screen.getByRole("button", { name: "Save editor" }));
    await waitFor(() => expect(requests).toHaveLength(1));

    fireEvent.change(screen.getByRole("textbox", { name: "Description source" }), { target: { value: "later source" } });
    fireEvent.click(screen.getByRole("button", { name: "Save editor" }));
    expect(requests).toHaveLength(1);

    firstEditor.unmount();
    render(<Harness />);

    await act(async () => requests[0]!.resolve());
    await waitFor(() => expect(requests).toHaveLength(2));
    await act(async () => requests[1]!.resolve());

    expect(persisted).toBe("later source");
  });
  it("drops a queued save after explicit cancel", async () => {
    let persisted = "";
    const requests: { source: string; resolve: () => void }[] = [];
    const save = vi.fn((_id: string, data: { description: string }) =>
      new Promise<void>((resolve) => {
        requests.push({
          source: data.description,
          resolve: () => {
            persisted = data.description;
            resolve();
          },
        });
      }),
    );
    const task = { id: "task-cancel", description: "initial" };
    function Harness() {
      const [editing, setEditing] = useState(true);
      return (
        <TaskDescriptionSection
          isCreate={false}
          slug="demo"
          task={task}
          emptyContent=""
          taskTitles={undefined}
          taskKeys={undefined}
          editingDescription={editing}
          setEditingDescription={setEditing}
          setCreateDescription={() => {}}
          onSaveDescription={save}
        />
      );
    }

    render(<Harness />);
    const source = screen.getByRole("textbox", { name: "Description source" });
    fireEvent.change(source, { target: { value: "submitted source" } });
    fireEvent.click(screen.getByRole("button", { name: "Save editor" }));
    await waitFor(() => expect(requests).toHaveLength(1));
    fireEvent.change(source, { target: { value: "cancelled queued source" } });
    fireEvent.click(screen.getByRole("button", { name: "Save editor" }));
    fireEvent.click(screen.getByRole("button", { name: "Revert editor" }));

    await act(async () => {
      requests[0]!.resolve();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(requests).toHaveLength(1);
    expect(persisted).toBe("submitted source");
  });
  it("isolates prior-task queued saves from a new task editor's revert and completion", async () => {
    const persisted: Record<string, string> = {};
    const requests: { taskId: string; source: string; resolve: () => void }[] = [];
    const save = (taskId: string, data: { description: string }) => new Promise<void>((resolve) => {
      requests.push({ taskId, source: data.description, resolve: () => {
        persisted[taskId] = data.description;
        resolve();
      } });
    });
    const taskA = { id: "task-a", description: "# A" };
    const taskB = { id: "task-b", description: "# B" };

    function Harness({ task }: { task: typeof taskA }) {
      const [editing, setEditing] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setEditing(true)}>Edit description</button>
          <TaskDescriptionSection
            isCreate={false}
            slug="demo"
            task={task}
            emptyContent=""
            taskTitles={undefined}
            taskKeys={undefined}
            editingDescription={editing}
            setEditingDescription={setEditing}
            setCreateDescription={() => {}}
            onSaveDescription={save}
          />
        </>
      );
    }

    const ui = render(<Harness task={taskA} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Description source" }), { target: { value: "A first" } });
    fireEvent.click(screen.getByRole("button", { name: "Save editor" }));
    await waitFor(() => expect(requests).toHaveLength(1));
    fireEvent.change(screen.getByRole("textbox", { name: "Description source" }), { target: { value: "A latest" } });
    fireEvent.click(screen.getByRole("button", { name: "Save editor" }));
    ui.rerender(<Harness task={taskB} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit description" }));
    fireEvent.click(screen.getByRole("button", { name: "Revert editor" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit description" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Description source" }), { target: { value: "B unsent" } });
    await act(async () => requests[0]!.resolve());
    await waitFor(() => expect(requests).toHaveLength(2));
    await act(async () => requests[1]!.resolve());
    expect(persisted).toEqual({ "task-a": "A latest" });
    expect(screen.getByRole("textbox", { name: "Description source" })).toHaveValue("B unsent");
  });
});
