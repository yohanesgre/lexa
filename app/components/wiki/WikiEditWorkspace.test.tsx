// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import type { WikiPage } from "../../../shared/types";

const editorMock = vi.hoisted(() => {
  const state: { content: unknown; isEditable: boolean } = {
    content: { type: "doc", content: [] },
    isEditable: false,
  };
  const listeners = new Map<string, Array<() => void>>();
  let onUpdate: (() => void) | undefined;
  return {
    state,
    reset(content: unknown) {
      state.content = content;
      state.isEditable = false;
    },
    bindOnUpdate(cb: (() => void) | undefined) {
      onUpdate = cb;
    },
    editor: {
      get isEditable() {
        return state.isEditable;
      },
      getJSON: () => state.content,
      on: (event: string, cb: () => void) => {
        const arr = listeners.get(event) ?? [];
        arr.push(cb);
        listeners.set(event, arr);
      },
      off: (event: string, cb: () => void) => {
        const arr = listeners.get(event) ?? [];
        listeners.set(event, arr.filter((fn) => fn !== cb));
      },
      commands: {
        setContent: (content: unknown, options?: { emitUpdate?: boolean }) => {
          state.content = content;
          if (options?.emitUpdate !== false) onUpdate?.();
        },
      },
      setEditable: (editable: boolean, emitUpdate = true) => {
        state.isEditable = editable;
        if (emitUpdate !== false) onUpdate?.();
      },
    },
  };
});

// Mimic @tiptap/react's immediatelyRender:false contract: the editor instance
// is null on the first render and only exists after mount.
vi.mock("@tiptap/react", async () => {
  const React = await import("react");
  return {
    useEditor: (config: { onUpdate?: () => void }) => {
      editorMock.bindOnUpdate(config.onUpdate);
      const [ready, setReady] = React.useState(false);
      React.useEffect(() => {
        setReady(true);
      }, []);
      return ready ? editorMock.editor : null;
    },
  };
});

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../lib/queries", () => ({
  useUpdateWikiPage: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRestoreWikiRevision: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("../../lib/useAttachmentEmbeds", () => ({
  useAttachmentEmbeds: () => ({ handlePaste: vi.fn(), handleDrop: vi.fn() }),
}));
vi.mock("../../lib/mention-suggestion", () => ({ createMentionExtension: () => ({}) }));
vi.mock("../../lib/api", () => ({ getWikiRevision: vi.fn() }));
vi.mock("./WikiEditSplit", () => ({ WikiEditSplit: () => null }));
vi.mock("./PageSettingsPanel", () => ({ PageSettingsPanel: () => null }));

import { WikiEditWorkspace } from "./WikiEditWorkspace";

const EMPTY_DOC = { type: "doc", content: [] };
const DOC = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Alpha body" }] }],
};

const page: WikiPage = {
  id: "w1",
  projectId: "p1",
  title: "Alpha",
  slug: "alpha",
  parentId: null,
  position: 0,
  updatedBy: null,
  updatedByName: null,
  updatedAt: "2026-08-20T10:00:00.000Z",
  content: DOC as WikiPage["content"],
  createdAt: "2026-08-01T10:00:00.000Z",
};

beforeEach(() => {
  localStorage.clear();
  editorMock.reset(EMPTY_DOC);
});

describe("WikiEditWorkspace deferred editor", () => {
  it("enables the deferred editor and applies content once it mounts", async () => {
    render(<WikiEditWorkspace slug="demo" page={page} breadcrumb="Home" onDone={vi.fn()} />);

    // The mocked useEditor returns null on the first render and only produces
    // the instance after mount, mirroring immediatelyRender:false. The start
    // effect must wait for that instance — consuming its one-shot guard while
    // editor is null would leave the editor read-only forever.
    await waitFor(() => expect(editorMock.state.isEditable).toBe(true));
    expect(editorMock.state.content).toEqual(DOC);
  });
});
