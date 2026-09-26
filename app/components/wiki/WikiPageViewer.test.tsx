// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { WikiPage } from "../../../shared/types";

const editorState = vi.hoisted(() => ({ editing: false }));

vi.mock("../tiptap-render", () => ({
  renderDoc: () => null,
  extractHeadings: () => [],
  slugifyHeading: (value: string) => value,
}));

vi.mock("./useWikiEditor", () => ({
  useWikiEditor: () => ({
    editor: null,
    isEditing: editorState.editing,
    title: "Home",
    lastSavedPage: {
      id: "w1",
      projectId: "p1",
      title: "Home",
      slug: "home",
      parentId: null,
      position: 0,
      updatedBy: "u1",
      updatedByName: "Al",
      updatedAt: "2026-08-20T10:00:00.000Z",
      content: { type: "doc", content: [] },
      createdAt: "2026-08-01T10:00:00.000Z",
    },
    lastSavedAt: null,
    isDirty: false,
    isSaving: false,
    restoring: false,
    previewContent: { type: "doc", content: [] },
    historyPreviewId: null,
    autosaveEnabled: false,
    autosaveDelay: 800,
    setAutosaveEnabled: vi.fn(),
    setAutosaveDelay: vi.fn(),
    handleStartEditing: vi.fn(),
    handleCancel: vi.fn(),
    handleSave: vi.fn(),
    handleSelectRevision: vi.fn(),
    handleClosePreview: vi.fn(),
    handleRestore: vi.fn(),
    handleReviewStateChange: vi.fn(),
    handleTitleChange: vi.fn(),
  }),
}));

vi.mock("./WikiEditSplit", () => ({ WikiEditSplit: () => null }));
vi.mock("../runtimes/SourcesSection", () => ({ SourcesSection: () => null }));
vi.mock("./ShareDialog", () => ({ ShareDialog: () => null }));
vi.mock("../../lib/queries", () => ({
  useRevisions: () => ({ data: [], isLoading: false, error: null }),
}));

import { WikiPageViewer } from "./WikiPageViewer";

const PAGE: WikiPage = {
  id: "w1",
  projectId: "p1",
  title: "Home",
  slug: "home",
  parentId: null,
  position: 0,
  updatedBy: "u1",
  updatedByName: "Al",
  updatedAt: "2026-08-20T10:00:00.000Z",
  content: { type: "doc", content: [] },
  createdAt: "2026-08-01T10:00:00.000Z",
};

beforeEach(() => {
  editorState.editing = false;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    }
  );
});

describe("WikiPageViewer last-edited author", () => {
  it("renders the author name when present", () => {
    render(<WikiPageViewer slug="demo" page={PAGE} pages={[PAGE]} />);
    expect(screen.getByText(/Last edited .* by Al/)).toBeInTheDocument();
  });

  it("omits the author name when unknown", () => {
    render(<WikiPageViewer slug="demo" page={{ ...PAGE, updatedByName: null }} pages={[PAGE]} />);
    expect(screen.queryByText(/ by /)).not.toBeInTheDocument();
    expect(screen.getByText(/Last edited/)).toBeInTheDocument();
  });
});

describe("WikiPageViewer sidebar exclusivity", () => {
  it("mounts only the Contents panel in read mode", () => {
    render(<WikiPageViewer slug="demo" page={PAGE} pages={[PAGE]} />);
    expect(document.querySelector(".outline-sidebar")).toBeInTheDocument();
    expect(document.querySelector(".wiki-edit-sidebar")).toBeNull();
  });

  it("mounts only the Page settings panel in edit mode", () => {
    editorState.editing = true;
    render(<WikiPageViewer slug="demo" page={PAGE} pages={[PAGE]} />);
    expect(document.querySelector(".wiki-edit-sidebar")).toBeInTheDocument();
    expect(document.querySelector(".outline-sidebar")).toBeNull();
  });
});
