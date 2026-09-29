// @vitest-environment jsdom
// Assistant panel session hook: rehydrates the last run per document without
// re-POSTing a terminal stream, and keeps the prompt draft + skill choice in
// the module store across mounts.
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { useAssistantPanel } from "./use-assistant-panel";
import {
  getAssistantPanelSession,
  patchAssistantPanelSession,
  resetAssistantPanelSessions,
} from "../components/assistant/panel/assistant-panel-store";

const h = vi.hoisted(() => ({
  snapshot: { status: "idle" } as { status: string },
  send: vi.fn(),
  mutate: vi.fn(),
  settings: { model: "gpt", baseUrl: undefined, kind: "openai_compatible" },
  refetch: vi.fn(),
}));

vi.mock("./use-assistant-stream", () => ({
  useAssistantStream: () => ({ ...h.snapshot, send: h.send, abort: vi.fn(), reset: vi.fn(), subscribe: vi.fn(), getSnapshot: () => h.snapshot }),
  assistantGetSnapshot: () => h.snapshot,
}));

vi.mock("./queries", () => ({
  useProjects: () => ({ data: [{ id: "p1", slug: "demo" }] }),
  useAgents: () => ({ data: [{ id: "assistant", skillIds: ["s1", "s2"] }] }),
  useSkills: () => ({ data: [{ id: "s1", name: "Polish" }, { id: "s2", name: "Review" }] }),
  useAssistantSettings: () => ({ data: h.settings, isLoading: false, isError: false, refetch: h.refetch }),
  useCreateAssistantTask: () => ({ mutate: h.mutate, isPending: false }),
  useCancelAssistantTask: () => ({ mutate: vi.fn() }),
  useTaskAttachments: () => ({ data: undefined }),
  useWikiAttachments: () => ({ data: undefined }),
  useAssistantTask: () => ({ data: undefined }),
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
      <span data-testid="selection">{panel.selectionText}</span>
      <span data-testid="prompt">{panel.prompt}</span>
      <span data-testid="skill">{panel.effectiveSkillId}</span>
      <button type="button" onClick={panel.generate}>generate</button>
      <button type="button" onClick={() => panel.setPrompt("typed")}>type</button>
    </div>
  );
}

beforeEach(() => {
  resetAssistantPanelSessions();
  h.snapshot = { status: "idle" };
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

  it("starts the stream for a freshly created task", () => {
    h.mutate.mockImplementation((_input: unknown, opts?: { onSuccess?: (task: { id: string }) => void }) => {
      opts?.onSuccess?.({ id: "t9" });
    });
    const { editor } = makeEditor();
    render(<Harness editor={editor} documentId="t2" />);
    fireEvent.click(screen.getByRole("button", { name: "generate" }));
    expect(h.mutate).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith("/api/assistant/tasks/t9/stream", {});
    expect(screen.getByTestId("task")).toHaveTextContent("t9");
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
    patchAssistantPanelSession("alpha", "wiki", "shared", { prompt: "alpha draft", skillId: "s2", taskId: "tA" });
    const { editor } = makeEditor();
    render(<Harness editor={editor} slug="beta" documentType="wiki" documentId="shared" />);
    expect(screen.getByTestId("prompt")).toHaveTextContent("");
    expect(screen.getByTestId("task")).toHaveTextContent("none");
    expect(screen.getByTestId("skill")).toHaveTextContent("s1");
    expect(getAssistantPanelSession("beta", "wiki", "shared").prompt).toBe("");
    // The other project's bucket is untouched.
    expect(getAssistantPanelSession("alpha", "wiki", "shared").prompt).toBe("alpha draft");
  });
});
