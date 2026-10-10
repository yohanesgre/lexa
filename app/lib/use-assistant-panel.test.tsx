// @vitest-environment jsdom
// Assistant panel session hook: rehydrates the last run per document without
// re-POSTing a terminal stream, and keeps the prompt draft in the module store
// across mounts.
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { useAssistantPanel } from "./use-assistant-panel";
import { AssistantPanel } from "../components/assistant/panel/AssistantPanel";
import {
  getAssistantPanelSession,
  patchAssistantPanelSession,
  resetAssistantPanelSessions,
} from "../components/assistant/panel/assistant-panel-store";

const h = vi.hoisted(() => ({
  snapshot: { status: "idle", text: "" } as { status: string; text?: string },
  send: vi.fn(),
  mutate: vi.fn(),
  settings: { model: "gpt", baseUrl: undefined, kind: "openai_compatible" },
  refetch: vi.fn(),
  task: undefined as
    | { status: string; result?: string; error?: string; documentType?: "task" | "wiki"; documentId?: string }
    | undefined,
  keys: [] as (string | null)[],
}));

vi.mock("@tanstack/react-router", () => ({
  Link: (props: { children?: React.ReactNode }) => <a href="#settings">{props.children}</a>,
}));

vi.mock("./use-assistant-stream", () => ({
  useAssistantStream: (key: string | null) => {
    h.keys.push(key);
    return {
      frames: [],
      text: "",
      tools: [],
      items: [],
      reasoningText: "",
      reasoningActive: false,
      reasoningMs: null,
      pending: [],
      suspendedBatchId: null,
      error: null,
      usage: null,
      hasIngress: false,
      ...h.snapshot,
      send: h.send,
      abort: vi.fn(),
      reset: vi.fn(),
      subscribe: vi.fn(),
      getSnapshot: () => h.snapshot,
    };
  },
  // The create path boots the freshly-created run's session through the module
  // store (the hook is still bound to the previous key that tick).
  assistantSendForKey: (...args: unknown[]) => h.send(...args),
}));

vi.mock("./queries", () => ({
  useProjects: () => ({ data: [{ id: "p1", slug: "demo" }] }),
  useAssistantSettings: () => ({ data: h.settings, isLoading: false, isError: false, refetch: h.refetch }),
  useCreateAssistantTask: () => ({ mutate: h.mutate, isPending: false }),
  useCancelAssistantTask: () => ({ mutate: vi.fn() }),
  useTaskAttachments: () => ({ data: undefined }),
  useWikiAttachments: () => ({ data: undefined }),
  useAssistantTask: (taskId: string | null) => ({ data: taskId ? h.task : undefined }),
}));

type Selection = { from: number; to: number; text: string };

function makeEditor() {
  const selection: Selection = { from: 0, to: 0, text: "" };
  const handlers = new Map<string, Set<() => void>>();
  const editor = {
    state: {
      selection,
      doc: {
        toJSON: () => ({ type: "doc", content: [] }),
        textBetween: () => selection.text,
        textContent: "",
        slice: () => ({ content: { toJSON: () => [] } }),
      },
    },
    on: (event: string, fn: () => void) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(fn);
    },
    off: (event: string, fn: () => void) => {
      handlers.get(event)?.delete(fn);
    },
    emit: (event: string) => {
      handlers.get(event)?.forEach((fn) => fn());
    },
  };
  return { editor: editor as unknown as Editor, selection, emit: editor.emit };
}

function Harness({ editor, documentId, slug = "demo", documentType = "task" }: { editor: Editor; documentId: string; slug?: string; documentType?: "task" | "wiki" }) {
  const panel = useAssistantPanel({ editor, slug, documentType, documentId });
  return (
    <div>
      <span data-testid="task">{panel.taskId ?? "none"}</span>
      <span data-testid="status">{panel.stream.status}</span>
      <span data-testid="text">{panel.stream.text}</span>
      <span data-testid="selection">{panel.selectionText}</span>
      <span data-testid="prompt">{panel.prompt}</span>
      <button type="button" onClick={panel.generate}>generate</button>
      <button type="button" onClick={() => panel.setPrompt("typed")}>type</button>
    </div>
  );
}

beforeEach(() => {
  resetAssistantPanelSessions();
  h.snapshot = { status: "idle", text: "" };
  h.task = undefined;
  h.keys.length = 0;
  h.send.mockClear();
  h.mutate.mockReset();
});

describe("useAssistantPanel", () => {
  it("rehydrates a terminal run without re-POSTing the stream", () => {
    h.snapshot = { status: "done" };
    patchAssistantPanelSession("demo", "task", "t1", { taskId: "t1" });
    const { editor } = makeEditor();
    render(<Harness editor={editor} documentId="t1" />);
    expect(screen.getByTestId("task")).toHaveTextContent("t1");
    expect(screen.getByTestId("status")).toHaveTextContent("done");
    expect(h.send).not.toHaveBeenCalled();
  });

  it("synthesizes connecting from the task row for a freshly created task", () => {
    h.task = { status: "queued" };
    h.mutate.mockImplementation((_input: unknown, opts?: { onSuccess?: (task: { id: string }) => void }) => {
      opts?.onSuccess?.({ id: "t9" });
    });
    const { editor } = makeEditor();
    render(<Harness editor={editor} documentId="t2" />);
    expect(screen.getByTestId("status")).toHaveTextContent("idle");
    fireEvent.click(screen.getByRole("button", { name: "generate" }));
    // The server enqueues on POST /api/assistant/tasks; the client then boots the
    // run's SSE session on the document thread, and the pending task row drives
    // the connecting state until the first frame.
    expect(h.mutate).toHaveBeenCalledTimes(1);
    // Auto skill selection: the payload carries no skillId.
    expect(h.mutate.mock.calls[0]?.[0]).not.toHaveProperty("skillId");
    expect(h.send).toHaveBeenCalledWith("assistant-task:t2", "/api/assistant/tasks/t9/stream", {});
    expect(screen.getByTestId("task")).toHaveTextContent("t9");
    expect(screen.getByTestId("status")).toHaveTextContent("connecting");
  });

  it("renders frames from the SSE task stream after create", () => {
    h.task = { status: "running", documentType: "task", documentId: "doc1" };
    h.mutate.mockImplementation((_input: unknown, opts?: { onSuccess?: (task: { id: string }) => void }) => {
      opts?.onSuccess?.({ id: "t9" });
    });
    const { editor } = makeEditor();
    render(<Harness editor={editor} documentId="doc1" />);
    fireEvent.click(screen.getByRole("button", { name: "generate" }));
    expect(h.send).toHaveBeenCalledWith("assistant-task:doc1", "/api/assistant/tasks/t9/stream", {});

    // The in-process stream's frames render in the panel.
    h.snapshot = { status: "streaming", text: "streamed from SSE" };
    fireEvent.click(screen.getByRole("button", { name: "type" }));
    expect(screen.getByTestId("status")).toHaveTextContent("streaming");
    expect(screen.getByTestId("text")).toHaveTextContent("streamed from SSE");
  });

  it("reconstructs a background-completed run from the task row", () => {
    h.task = { status: "completed", result: "final markdown" };
    patchAssistantPanelSession("demo", "task", "t5", { taskId: "t5" });
    const { editor } = makeEditor();
    render(<Harness editor={editor} documentId="t5" />);
    expect(screen.getByTestId("task")).toHaveTextContent("t5");
    expect(screen.getByTestId("status")).toHaveTextContent("done");
    expect(screen.getByTestId("text")).toHaveTextContent("final markdown");
  });

  it("prefers connecting over the previous run's terminal state on a same-document rerun", () => {
    h.snapshot = { status: "done", text: "first result" };
    h.task = { status: "completed", result: "first result", documentType: "task", documentId: "doc1" };
    patchAssistantPanelSession("demo", "task", "doc1", { taskId: "t1" });
    h.mutate.mockImplementation((_input: unknown, opts?: { onSuccess?: (task: { id: string }) => void }) => {
      opts?.onSuccess?.({ id: "t2" });
    });
    const { editor } = makeEditor();
    render(<Harness editor={editor} documentId="doc1" />);
    expect(screen.getByTestId("status")).toHaveTextContent("done");

    // Second Generate on the SAME document: the reused thread still carries the
    // previous turn's ingress (live reports done), but the new task row is
    // queued — the stale terminal state must not render as Done until the new
    // run's first frame.
    h.task = { status: "queued", documentType: "task", documentId: "doc1" };
    fireEvent.click(screen.getByRole("button", { name: "generate" }));
    expect(screen.getByTestId("task")).toHaveTextContent("t2");
    expect(screen.getByTestId("status")).toHaveTextContent("connecting");

    // Once the new run streams, the live state wins again.
    h.snapshot = { status: "streaming", text: "second delta" };
    fireEvent.click(screen.getByRole("button", { name: "type" }));
    expect(screen.getByTestId("status")).toHaveTextContent("streaming");
    expect(screen.getByTestId("text")).toHaveTextContent("second delta");
  });

  it("tracks the editor selection for the label", () => {
    const { editor, selection, emit } = makeEditor();
    render(<Harness editor={editor} documentId="t3" />);
    expect(screen.getByTestId("selection")).toHaveTextContent("");
    selection.text = "hello";
    act(() => emit("selectionUpdate"));
    expect(screen.getByTestId("selection")).toHaveTextContent("hello");
  });

  it("restores and persists the prompt draft per document", () => {
    patchAssistantPanelSession("demo", "task", "t4", { prompt: "draft" });
    const { editor } = makeEditor();
    render(<Harness editor={editor} documentId="t4" />);
    expect(screen.getByTestId("prompt")).toHaveTextContent("draft");
    fireEvent.click(screen.getByRole("button", { name: "type" }));
    expect(screen.getByTestId("prompt")).toHaveTextContent("typed");
    expect(getAssistantPanelSession("demo", "task", "t4").prompt).toBe("typed");
  });

  it("never persists create-mode state under an empty document id", () => {
    patchAssistantPanelSession("demo", "task", "", { prompt: "leak" });
    expect(getAssistantPanelSession("demo", "task", "").prompt).toBe("");
  });

  it("does not share wiki session state across projects with the same slug", () => {
    patchAssistantPanelSession("alpha", "wiki", "shared", { prompt: "alpha draft", taskId: "tA" });
    const { editor } = makeEditor();
    render(<Harness editor={editor} slug="beta" documentType="wiki" documentId="shared" />);
    expect(screen.getByTestId("prompt")).toHaveTextContent("");
    expect(screen.getByTestId("task")).toHaveTextContent("none");
    expect(getAssistantPanelSession("beta", "wiki", "shared").prompt).toBe("");
    // The other project's bucket is untouched.
    expect(getAssistantPanelSession("alpha", "wiki", "shared").prompt).toBe("alpha draft");
  });

  it("subscribes a task run to the document thread, not the task id", () => {
    h.task = { status: "running", documentType: "task", documentId: "doc1" };
    patchAssistantPanelSession("demo", "task", "doc1", { taskId: "t9" });
    const { editor } = makeEditor();
    render(<Harness editor={editor} documentId="doc1" />);
    expect(h.keys).toContain("assistant-task:doc1");
    expect(h.keys).not.toContain("assistant-task:t9");
  });

  it("subscribes a wiki run to the wiki document thread", () => {
    h.task = { status: "running", documentType: "wiki", documentId: "page-slug" };
    patchAssistantPanelSession("demo", "wiki", "page-slug", { taskId: "t10" });
    const { editor } = makeEditor();
    render(<Harness editor={editor} documentType="wiki" documentId="page-slug" />);
    expect(h.keys).toContain("assistant-wiki:page-slug");
  });

  it("renders streamed deltas on the document thread and lands on the Done view", () => {
    h.task = { status: "running", documentType: "task", documentId: "doc1" };
    h.snapshot = { status: "streaming", text: "delta one " };
    patchAssistantPanelSession("demo", "task", "doc1", { taskId: "t9" });
    const { editor } = makeEditor();
    const onClose = vi.fn();
    const { rerender } = render(
      <AssistantPanel editor={editor} slug="demo" documentType="task" documentId="doc1" onClose={onClose} />
    );
    expect(h.keys.at(-1)).toBe("assistant-task:doc1");
    expect(screen.getByText(/delta one/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Stop/ })).toBeInTheDocument();

    // The run lands on the terminal Done view (task row authoritative for the
    // background-completed result).
    h.snapshot = { status: "done", text: "final result" };
    h.task = { status: "completed", result: "final result", documentType: "task", documentId: "doc1" };
    rerender(
      <AssistantPanel editor={editor} slug="demo" documentType="task" documentId="doc1" onClose={onClose} />
    );
    expect(screen.getByRole("button", { name: /Review in editor/ })).toBeInTheDocument();
  });
});
