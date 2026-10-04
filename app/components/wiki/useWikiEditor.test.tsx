// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TipTapDoc, WikiPage } from "../../../shared/types";

const editorMock = vi.hoisted(() => {
  const state: { content: unknown } = { content: { type: "doc", content: [] } };
  const listeners = new Map<string, Array<() => void>>();
  return {
    reset(content: unknown) {
      state.content = content;
    },
    editor: {
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
        setContent: (content: unknown) => {
          state.content = content;
        },
      },
      setEditable: () => {},
    },
  };
});

const mutationMock = vi.hoisted(() => ({ mutateAsync: vi.fn(), isPending: false }));
const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("@tiptap/react", () => ({ useEditor: () => editorMock.editor }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigateMock }));
vi.mock("../../lib/queries", () => ({
  // Mirror @tanstack/react-query's useMutation: a fresh object every render.
  useUpdateWikiPage: () => ({ mutateAsync: mutationMock.mutateAsync, isPending: false }),
  useRestoreWikiRevision: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("../../lib/useAttachmentEmbeds", () => ({
  useAttachmentEmbeds: () => ({ handlePaste: vi.fn(), handleDrop: vi.fn() }),
}));
vi.mock("../../lib/mention-suggestion", () => ({ createMentionExtension: () => ({}) }));
vi.mock("../../lib/api", () => ({ getWikiRevision: vi.fn() }));

import { useWikiEditor } from "./useWikiEditor";

const DOC_A: TipTapDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Alpha body" }] }] };
const DOC_B: TipTapDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Beta body" }] }] };

const pageA: WikiPage = {
  id: "w1",
  projectId: "p1",
  title: "Alpha",
  slug: "alpha",
  parentId: null,
  position: 0,
  updatedBy: null,
  updatedByName: null,
  updatedAt: "2026-08-20T10:00:00.000Z",
  content: DOC_A,
  createdAt: "2026-08-01T10:00:00.000Z",
};

const pageB: WikiPage = {
  ...pageA,
  id: "w2",
  title: "Beta",
  slug: "beta",
  content: DOC_B,
};

function Harness({ page }: { page: WikiPage }) {
  const w = useWikiEditor({ slug: "demo", page });
  return (
    <div>
      <span data-testid="editing">{String(w.isEditing)}</span>
      <span data-testid="dirty">{String(w.isDirty)}</span>
      <span data-testid="lastSavedAt">{w.lastSavedAt ? "yes" : "no"}</span>
      <span data-testid="title">{w.title}</span>
      <button type="button" onClick={w.handleStartEditing}>
        edit
      </button>
      <button type="button" onClick={() => w.handleTitleChange("Renamed")}>
        rename
      </button>
      <button type="button" onClick={() => w.handleTitleChange("Renamed 2")}>
        rename2
      </button>
      <button type="button" onClick={() => w.handleReviewStateChange(true, false)}>
        review-on
      </button>
      <button type="button" onClick={() => void w.handleSave()}>
        save
      </button>
    </div>
  );
}

beforeEach(() => {
  mutationMock.mutateAsync.mockReset();
  navigateMock.mockReset();
  localStorage.clear();
  editorMock.reset(DOC_A);
});

describe("useWikiEditor autosave", () => {
  it("fires after the debounce and applies saved", async () => {
    localStorage.setItem("lexa-wiki-autosave", "true");
    localStorage.setItem("lexa-wiki-autosave-delay", "20");
    mutationMock.mutateAsync.mockResolvedValue({ ...pageA, title: "Renamed" });

    render(<Harness page={pageA} />);
    fireEvent.click(screen.getByText("edit"));
    fireEvent.click(screen.getByText("rename"));

    await waitFor(() => expect(mutationMock.mutateAsync).toHaveBeenCalledTimes(1));
    const payload = mutationMock.mutateAsync.mock.calls[0]![0] as { saveType: string; pageSlug: string };
    expect(payload.saveType).toBe("autosave");
    expect(payload.pageSlug).toBe("alpha");

    await waitFor(() => expect(screen.getByTestId("dirty")).toHaveTextContent("false"));
    expect(screen.getByTestId("lastSavedAt")).toHaveTextContent("yes");
  });
});

describe("useWikiEditor edit during save", () => {
  it("keeps newer edits when an in-flight save resolves stale (LX-92)", async () => {
    localStorage.setItem("lexa-wiki-autosave", "true");
    localStorage.setItem("lexa-wiki-autosave-delay", "10");

    const resolvers: Array<(page: WikiPage) => void> = [];
    mutationMock.mutateAsync.mockImplementation(
      () => new Promise<WikiPage>((resolve) => { resolvers.push(resolve); })
    );

    render(<Harness page={pageA} />);
    fireEvent.click(screen.getByText("edit"));
    fireEvent.click(screen.getByText("rename"));

    // Let the autosave debounce fire; its request is now in flight.
    await waitFor(() => expect(mutationMock.mutateAsync).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("dirty")).toHaveTextContent("true");

    // A newer edit lands while the first request is still pending. Review mode
    // suppresses the autosave trigger, so the in-flight request is not
    // interrupted and can resolve after the edit — the stale case.
    fireEvent.click(screen.getByText("review-on"));
    fireEvent.click(screen.getByText("rename2"));
    expect(screen.getByTestId("title")).toHaveTextContent("Renamed 2");

    // The stale response must not overwrite the newer title nor clear dirty.
    resolvers[0]!({ ...pageA, title: "Renamed" });
    await waitFor(() => expect(screen.getByTestId("lastSavedAt")).toHaveTextContent("yes"));

    expect(screen.getByTestId("title")).toHaveTextContent("Renamed 2");
    expect(screen.getByTestId("dirty")).toHaveTextContent("true");
  });
});

describe("useWikiEditor page switch", () => {
  it("resets edit state on slug change and never PATCHes the old content to the new slug", async () => {
    localStorage.setItem("lexa-wiki-autosave", "false");

    const { rerender } = render(<Harness page={pageA} />);
    fireEvent.click(screen.getByText("edit"));
    fireEvent.click(screen.getByText("rename"));
    expect(screen.getByTestId("editing")).toHaveTextContent("true");
    expect(screen.getByTestId("title")).toHaveTextContent("Renamed");

    rerender(<Harness page={pageB} />);

    await waitFor(() => expect(screen.getByTestId("editing")).toHaveTextContent("false"));
    expect(screen.getByTestId("title")).toHaveTextContent("Beta");
    expect(screen.getByTestId("dirty")).toHaveTextContent("false");

    // Nothing is dirty after the reset — an attempted save must be a no-op, not
    // a PATCH of Alpha's content into Beta's slug.
    fireEvent.click(screen.getByText("save"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(mutationMock.mutateAsync).not.toHaveBeenCalled();
  });

  it("does not adopt a late save response from the previous page", async () => {
    localStorage.setItem("lexa-wiki-autosave", "false");

    let resolveSave!: (page: WikiPage) => void;
    mutationMock.mutateAsync.mockReturnValue(
      new Promise<WikiPage>((resolve) => {
        resolveSave = resolve;
      })
    );

    const { rerender } = render(<Harness page={pageA} />);
    fireEvent.click(screen.getByText("edit"));
    fireEvent.click(screen.getByText("rename"));
    fireEvent.click(screen.getByText("save"));
    await waitFor(() => expect(mutationMock.mutateAsync).toHaveBeenCalledTimes(1));

    rerender(<Harness page={pageB} />);
    await waitFor(() => expect(screen.getByTestId("title")).toHaveTextContent("Beta"));

    // Save for Alpha resolves after the switch. It must not overwrite Beta.
    await act(async () => {
      resolveSave({ ...pageA, title: "Renamed" });
    });
    expect(screen.getByTestId("title")).toHaveTextContent("Beta");
  });
});
