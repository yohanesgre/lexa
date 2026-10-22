// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WikiPage, WikiPageRevision } from "../../../shared/types";

const mutationMock = vi.hoisted(() => ({ mutateAsync: vi.fn(), isPending: false }));
const restoreMock = vi.hoisted(() => ({ mutateAsync: vi.fn(), isPending: false }));
const navigateMock = vi.hoisted(() => vi.fn());
const revisionMock = vi.hoisted(() => ({ getWikiRevision: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigateMock }));
vi.mock("../../lib/queries", () => ({
  useUpdateWikiPage: () => ({ mutateAsync: mutationMock.mutateAsync, isPending: false }),
  useRestoreWikiRevision: () => ({ mutateAsync: restoreMock.mutateAsync, isPending: false }),
}));
vi.mock("../../lib/api", () => ({ getWikiRevision: revisionMock.getWikiRevision }));

import { useWikiEditor } from "./useWikiEditor";

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
  content: "# Alpha\n\nOriginal source",
  createdAt: "2026-08-01T10:00:00.000Z",
};

const pageB: WikiPage = {
  ...pageA,
  id: "w2",
  title: "Beta",
  slug: "beta",
  content: "# Beta\n\nSecond page",
};

function revisionResult(content: string): { revision: WikiPageRevision } {
  return {
    revision: {
      id: "r1",
      pageId: pageA.id,
      title: pageA.title,
      slug: pageA.slug,
      content,
      contentText: content,
      saveType: "manual",
      createdAt: pageA.updatedAt,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function Harness({ page }: { page: WikiPage }) {
  const wiki = useWikiEditor({ slug: "demo", page });
  return (
    <div>
      <span data-testid="editing">{String(wiki.isEditing)}</span>
      <span data-testid="dirty">{String(wiki.isDirty)}</span>
      <span data-testid="saving">{String(wiki.isSaving)}</span>
      <span data-testid="manual-saving">{String(wiki.isManualSaving)}</span>
      <span data-testid="history-preview">{wiki.historyPreviewId ?? "none"}</span>
      <span data-testid="saved-title">{wiki.lastSavedPage.title}</span>
      <span data-testid="title">{wiki.title}</span>
      <textarea aria-label="Page source" value={wiki.source} onChange={(event) => wiki.handleMarkdownChange(event.target.value)} />
      <input aria-label="Page title" value={wiki.title} onChange={(event) => wiki.handleTitleChange(event.target.value)} />
      <button type="button" onClick={wiki.handleStartEditing}>Edit</button>
      <button type="button" onClick={wiki.handleCancel}>Cancel</button>
      <button type="button" onClick={() => void wiki.handleSave()}>Save</button>
      <button type="button" onClick={() => void wiki.handleSelectRevision("r1")}>Revision</button>
      <button type="button" onClick={wiki.handleClosePreview}>Close revision</button>
      <button type="button" onClick={() => void wiki.handleRestore("r1")}>Restore</button>
      <button type="button" onClick={() => wiki.handleReviewStateChange(true, false)}>Review</button>
      <button type="button" onClick={() => wiki.handleReviewStateChange(false, true)}>Accept review</button>
    </div>
  );
}

beforeEach(() => {
  mutationMock.mutateAsync.mockReset();
  restoreMock.mutateAsync.mockReset();
  revisionMock.getWikiRevision.mockReset();
  navigateMock.mockReset();
  localStorage.clear();
});

describe("useWikiEditor source saves", () => {
  it("keeps autosave off by default and manually saves exact Markdown", async () => {
    const source = '{"type":"doc","content":[]}\n\nUnicode: λ';
    mutationMock.mutateAsync.mockResolvedValue({ ...pageA, content: source });

    render(<Harness page={pageA} />);
    fireEvent.click(screen.getByText("Edit"));
    fireEvent.change(screen.getByLabelText("Page source"), { target: { value: source } });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
    expect(mutationMock.mutateAsync).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(mutationMock.mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutationMock.mutateAsync.mock.calls[0]![0]).toMatchObject({
      pageSlug: "alpha",
      content: source,
      saveType: "manual",
    });
    await waitFor(() => expect(screen.getByTestId("editing")).toHaveTextContent("false"));
    expect(screen.getByTestId("dirty")).toHaveTextContent("false");
  });

  it("keeps edits made during an autosave and saves latest source next", async () => {
    localStorage.setItem("lexa-wiki-autosave", "true");
    localStorage.setItem("lexa-wiki-autosave-delay", "10");
    const pending: ReturnType<typeof deferred<WikiPage>>[] = [];
    mutationMock.mutateAsync.mockImplementation(() => {
      const request = deferred<WikiPage>();
      pending.push(request);
      return request.promise;
    });

    render(<Harness page={pageA} />);
    fireEvent.click(screen.getByText("Edit"));
    fireEvent.change(screen.getByLabelText("Page source"), { target: { value: "# Alpha\n\nFirst edit" } });
    await waitFor(() => expect(mutationMock.mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutationMock.mutateAsync.mock.calls[0]![0]).toMatchObject({ content: "# Alpha\n\nFirst edit", saveType: "autosave" });

    fireEvent.change(screen.getByLabelText("Page source"), { target: { value: "# Alpha\n\nNewer edit" } });
    await act(async () => pending[0]!.resolve({ ...pageA, content: "# Alpha\n\nFirst edit" }));
    expect(screen.getByLabelText("Page source")).toHaveValue("# Alpha\n\nNewer edit");
    expect(screen.getByTestId("dirty")).toHaveTextContent("true");

    await waitFor(() => expect(mutationMock.mutateAsync).toHaveBeenCalledTimes(2));
    expect(mutationMock.mutateAsync.mock.calls[1]![0]).toMatchObject({ content: "# Alpha\n\nNewer edit", saveType: "autosave" });
    await act(async () => pending[1]!.resolve({ ...pageA, content: "# Alpha\n\nNewer edit" }));
    await waitFor(() => expect(screen.getByTestId("dirty")).toHaveTextContent("false"));
  });

  it("waits for an in-flight autosave before dispatching manual save", async () => {
    localStorage.setItem("lexa-wiki-autosave", "true");
    localStorage.setItem("lexa-wiki-autosave-delay", "30");
    const requests: ReturnType<typeof deferred<WikiPage>>[] = [];
    mutationMock.mutateAsync.mockImplementation(() => {
      const request = deferred<WikiPage>();
      requests.push(request);
      return request.promise;
    });

    render(<Harness page={pageA} />);
    fireEvent.click(screen.getByText("Edit"));
    fireEvent.change(screen.getByLabelText("Page source"), { target: { value: "# Alpha\n\nAutosave draft" } });
    await waitFor(() => expect(mutationMock.mutateAsync).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("Page source"), { target: { value: "# Alpha\n\nManual draft" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(screen.getByTestId("manual-saving")).toHaveTextContent("true"));
    expect(mutationMock.mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutationMock.mutateAsync.mock.calls[0]![0]).toMatchObject({
      content: "# Alpha\n\nAutosave draft",
      saveType: "autosave",
    });
    fireEvent.change(screen.getByLabelText("Page source"), { target: { value: "# Alpha\n\nIgnored during manual save" } });
    expect(screen.getByLabelText("Page source")).toHaveValue("# Alpha\n\nManual draft");

    await act(async () => requests[0]!.resolve({ ...pageA, content: "# Alpha\n\nAutosave draft" }));
    await waitFor(() => expect(mutationMock.mutateAsync).toHaveBeenCalledTimes(2));
    expect(mutationMock.mutateAsync.mock.calls[1]![0]).toMatchObject({
      content: "# Alpha\n\nManual draft",
      saveType: "manual",
    });
    expect(requests).toHaveLength(2);

    await act(async () => requests[1]!.resolve({ ...pageA, content: "# Alpha\n\nManual draft" }));
    await waitFor(() => expect(screen.getByTestId("editing")).toHaveTextContent("false"));
    expect(mutationMock.mutateAsync).toHaveBeenCalledTimes(2);
  });

  it("cancels a queued autosave before manual save", async () => {
    localStorage.setItem("lexa-wiki-autosave", "true");
    localStorage.setItem("lexa-wiki-autosave-delay", "10000");
    mutationMock.mutateAsync.mockResolvedValue({ ...pageA, content: "# Alpha\n\nManual draft" });

    render(<Harness page={pageA} />);
    fireEvent.click(screen.getByText("Edit"));
    fireEvent.change(screen.getByLabelText("Page source"), { target: { value: "# Alpha\n\nManual draft" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(screen.getByTestId("editing")).toHaveTextContent("false"));
    expect(mutationMock.mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutationMock.mutateAsync.mock.calls[0]![0]).toMatchObject({
      content: "# Alpha\n\nManual draft",
      saveType: "manual",
    });
  });

  it("locks source edits while a manual save is pending", async () => {
    const request = deferred<WikiPage>();
    mutationMock.mutateAsync.mockReturnValue(request.promise);
    render(<Harness page={pageA} />);
    fireEvent.click(screen.getByText("Edit"));
    fireEvent.change(screen.getByLabelText("Page source"), { target: { value: "submitted source" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(mutationMock.mutateAsync).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText("Page source"), { target: { value: "later source" } });
    expect(screen.getByLabelText("Page source")).toHaveValue("submitted source");
    expect(screen.getByTestId("dirty")).toHaveTextContent("true");
    expect(screen.getByTestId("manual-saving")).toHaveTextContent("true");
    await act(async () => request.resolve({ ...pageA, content: "submitted source" }));

    await waitFor(() => expect(screen.getByTestId("editing")).toHaveTextContent("false"));
    expect(screen.getByLabelText("Page source")).toHaveValue("submitted source");
  });

  it("does not adopt or navigate from a save canceled before response", async () => {
    const request = deferred<WikiPage>();
    mutationMock.mutateAsync.mockReturnValue(request.promise);

    render(<Harness page={pageA} />);
    fireEvent.click(screen.getByText("Edit"));
    fireEvent.change(screen.getByLabelText("Page title"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(mutationMock.mutateAsync).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.getByTestId("title")).toHaveTextContent("Alpha");
    await act(async () => request.resolve({ ...pageA, title: "Renamed", slug: "renamed" }));
    expect(screen.getByTestId("title")).toHaveTextContent("Alpha");
    expect(screen.getByTestId("saved-title")).toHaveTextContent("Alpha");
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("isolates late saves after switching pages", async () => {
    const request = deferred<WikiPage>();
    mutationMock.mutateAsync.mockReturnValue(request.promise);
    const { rerender } = render(<Harness page={pageA} />);
    fireEvent.click(screen.getByText("Edit"));
    fireEvent.change(screen.getByLabelText("Page title"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(mutationMock.mutateAsync).toHaveBeenCalledTimes(1));

    rerender(<Harness page={pageB} />);
    await waitFor(() => expect(screen.getByTestId("title")).toHaveTextContent("Beta"));
    await act(async () => request.resolve({ ...pageA, title: "Renamed" }));
    expect(screen.getByTestId("title")).toHaveTextContent("Beta");
    expect(screen.getByTestId("saved-title")).toHaveTextContent("Beta");
  });

  it("ignores a revision response after page switch", async () => {
    const request = deferred<{ revision: { content: string } }>();
    revisionMock.getWikiRevision.mockReturnValue(request.promise);
    const { rerender } = render(<Harness page={pageA} />);
    fireEvent.click(screen.getByText("Edit"));
    fireEvent.click(screen.getByText("Revision"));
    rerender(<Harness page={pageB} />);
    await act(async () => request.resolve({ revision: { content: "old revision" } }));
    expect(screen.getByLabelText("Page source")).toHaveValue(pageB.content);
  });

  it("keeps typing while a revision request is pending and rejects its stale response", async () => {
    const request = deferred<{ revision: WikiPageRevision }>();
    revisionMock.getWikiRevision.mockReturnValue(request.promise);
    render(<Harness page={pageA} />);
    fireEvent.click(screen.getByText("Edit"));
    fireEvent.click(screen.getByText("Revision"));
    await waitFor(() => expect(revisionMock.getWikiRevision).toHaveBeenCalledTimes(1));

    const draft = "# Alpha\n\nTyped while revision loads";
    fireEvent.change(screen.getByLabelText("Page source"), { target: { value: draft } });
    await act(async () => request.resolve(revisionResult("# Alpha\n\nOld revision")));

    expect(screen.getByLabelText("Page source")).toHaveValue(draft);
    expect(screen.getByTestId("history-preview")).toHaveTextContent("none");
    expect(screen.getByTestId("dirty")).toHaveTextContent("true");
  });

  it("restores the pre-preview draft when an accepted revision preview closes", async () => {
    const request = deferred<{ revision: WikiPageRevision }>();
    revisionMock.getWikiRevision.mockReturnValue(request.promise);
    render(<Harness page={pageA} />);
    fireEvent.click(screen.getByText("Edit"));
    const draft = "# Alpha\n\nWorking draft";
    fireEvent.change(screen.getByLabelText("Page source"), { target: { value: draft } });
    fireEvent.click(screen.getByText("Revision"));
    await waitFor(() => expect(revisionMock.getWikiRevision).toHaveBeenCalledTimes(1));

    const historical = revisionResult("# Alpha\n\nOld revision");
    historical.revision.title = "Former title";
    historical.revision.slug = "former-slug";
    await act(async () => request.resolve(historical));
    expect(screen.getByLabelText("Page source")).toHaveValue("# Alpha\n\nOld revision");
    expect(screen.getByTestId("history-preview")).toHaveTextContent("r1");
    fireEvent.change(screen.getByLabelText("Page source"), { target: { value: "Cannot edit a preview" } });
    expect(screen.getByLabelText("Page source")).toHaveValue("# Alpha\n\nOld revision");
    fireEvent.click(screen.getByText("Close revision"));
    expect(screen.getByLabelText("Page source")).toHaveValue(draft);
    expect(screen.getByTestId("history-preview")).toHaveTextContent("none");
    expect(screen.getByTestId("dirty")).toHaveTextContent("true");
  });

  it("never substitutes or saves historical content across an active Assistant review", async () => {
    localStorage.setItem("lexa-wiki-autosave", "true");
    localStorage.setItem("lexa-wiki-autosave-delay", "10");
    const request = deferred<{ revision: WikiPageRevision }>();
    revisionMock.getWikiRevision.mockReturnValue(request.promise);
    render(<Harness page={pageA} />);
    fireEvent.click(screen.getByText("Edit"));
    fireEvent.click(screen.getByText("Revision"));
    fireEvent.click(screen.getByText("Review"));
    await act(async () => request.resolve(revisionResult("# Historical")));
    expect(screen.getByLabelText("Page source")).toHaveValue(pageA.content);
    expect(screen.getByTestId("history-preview")).toHaveTextContent("none");
    await act(async () => fireEvent.click(screen.getByText("Revision")));
    expect(screen.getByLabelText("Page source")).toHaveValue(pageA.content);
    fireEvent.click(screen.getByText("Accept review"));

    await act(async () => fireEvent.click(screen.getByText("Revision")));
    expect(screen.getByLabelText("Page source")).toHaveValue("# Historical");
    fireEvent.click(screen.getByText("Review"));
    fireEvent.click(screen.getByText("Accept review"));
    fireEvent.change(screen.getByLabelText("Page title"), { target: { value: "Draft title" } });
    fireEvent.click(screen.getByText("Save"));
    await act(async () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 30);
      await promise;
    });
    expect(mutationMock.mutateAsync).not.toHaveBeenCalled();
    expect(screen.getByTestId("editing")).toHaveTextContent("true");
    fireEvent.click(screen.getByText("Close revision"));
    expect(screen.getByLabelText("Page source")).toHaveValue(pageA.content);
  });

  it("ignores a revision response after canceling the edit session", async () => {
    const request = deferred<{ revision: WikiPageRevision }>();
    revisionMock.getWikiRevision.mockReturnValue(request.promise);
    render(<Harness page={pageA} />);
    fireEvent.click(screen.getByText("Edit"));
    fireEvent.click(screen.getByText("Revision"));
    await waitFor(() => expect(revisionMock.getWikiRevision).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("Cancel"));

    await act(async () => request.resolve(revisionResult("# Alpha\n\nOld revision")));
    expect(screen.getByLabelText("Page source")).toHaveValue(pageA.content);
    expect(screen.getByTestId("history-preview")).toHaveTextContent("none");
    expect(screen.getByTestId("editing")).toHaveTextContent("false");
  });

  it("rejects a revision belonging to another page even when its request ID matches", async () => {
    const foreign = revisionResult("Foreign page source");
    foreign.revision.pageId = pageB.id;
    revisionMock.getWikiRevision.mockResolvedValue(foreign);
    render(<Harness page={pageA} />);
    fireEvent.click(screen.getByText("Edit"));
    await act(async () => fireEvent.click(screen.getByText("Revision")));
    expect(screen.getByLabelText("Page source")).toHaveValue(pageA.content);
    expect(screen.getByTestId("history-preview")).toHaveTextContent("none");
  });

  it("adopts restored Markdown only from the current edit session", async () => {
    const restoredSource = "# Restored\n\nSearchable restored text";
    restoreMock.mutateAsync.mockResolvedValue({ ...pageA, title: "Restored", content: restoredSource });
    render(<Harness page={pageA} />);
    fireEvent.click(screen.getByText("Edit"));
    fireEvent.click(screen.getByText("Restore"));
    await waitFor(() => expect(screen.getByLabelText("Page source")).toHaveValue(restoredSource));
    expect(screen.getByTestId("saved-title")).toHaveTextContent("Restored");
  });

  it("does not let an old restore response replace a canceled draft", async () => {
    const request = deferred<WikiPage>();
    restoreMock.mutateAsync.mockReturnValue(request.promise);
    render(<Harness page={pageA} />);
    fireEvent.click(screen.getByText("Edit"));
    fireEvent.click(screen.getByText("Restore"));
    fireEvent.click(screen.getByText("Cancel"));
    await act(async () => request.resolve({ ...pageA, title: "Restored", content: "stale restore" }));
    expect(screen.getByLabelText("Page source")).toHaveValue(pageA.content);
    expect(screen.getByTestId("title")).toHaveTextContent("Alpha");
  });
});
