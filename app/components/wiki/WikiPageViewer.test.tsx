// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { WikiPage } from "../../../shared/types";

vi.mock("../tiptap-render", () => ({
  renderDoc: () => null,
  extractHeadings: () => [],
  slugifyHeading: (value: string) => value,
}));

vi.mock("./useWikiEditor", () => ({
  useWikiEditor: () => ({
    editor: null,
    isEditing: false,
    title: "Home",
    lastSavedPage: undefined,
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
vi.mock("./EditSidebar", () => ({ EditSidebar: () => null }));
vi.mock("./OutlineSidebar", () => ({ OutlineSidebar: () => null }));
vi.mock("../hearth/SourcesSection", () => ({ SourcesSection: () => null }));
vi.mock("./ShareDialog", () => ({ ShareDialog: () => null }));

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
