// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Attachment } from "../../../shared/types";

const mutateAsync = vi.hoisted(() => vi.fn());
const attachments = vi.hoisted(() => [] as Attachment[]);

vi.mock("../../lib/queries", () => ({
  useWikiAttachments: () => ({ data: attachments }),
  useDeleteAttachment: () => ({ mutateAsync, isPending: false }),
  useSession: () => ({ data: { session: { userId: "u1" }, user: { id: "u1", role: "member" } } }),
}));

vi.mock("./WikiEditor", () => ({ WikiEditor: () => null }));

import { WikiEditSplit } from "./WikiEditSplit";

const base = {
  type: "doc" as const,
  content: [{ type: "paragraph", content: [{ type: "text", text: "Body" }] }],
};

function attachment(overrides: Partial<Attachment>): Attachment {
  return {
    id: "a1",
    projectId: "p1",
    taskId: null,
    wikiPageId: "wp1",
    filename: "whiteboard-sketch.png",
    mimeType: "image/png",
    sizeBytes: 86016,
    sha256: "abc",
    uploadedBy: "u1",
    uploadedByLabel: "Al",
    createdAt: "2026-08-20T10:00:00.000Z",
    ...overrides,
  };
}

function setAttachments(next: Attachment[]) {
  attachments.length = 0;
  attachments.push(...next);
}

function renderSplit(overrides: { updatedByName?: string | null; isSaving?: boolean; lastSavedLabel?: string } = {}) {
  return render(
    <WikiEditSplit
      editor={null}
      slug="demo"
      pageSlug="api-reference"
      previewContent={base}
      isSaving={overrides.isSaving ?? false}
      isDirty={false}
      lastSavedAt={null}
      lastSavedLabel={overrides.lastSavedLabel ?? "Last edited just now"}
      updatedByName={overrides.updatedByName ?? null}
      onReviewStateChange={vi.fn()}
    />
  );
}

describe("WikiEditSplit last-edited author", () => {
  it("appends the author name when present", () => {
    renderSplit({ lastSavedLabel: "Last edited 2 hours ago", updatedByName: "Al" });
    expect(screen.getByText("Last edited 2 hours ago by Al")).toBeInTheDocument();
  });

  it("omits the author while a save is in flight", () => {
    renderSplit({ lastSavedLabel: "Saving…", updatedByName: "Al", isSaving: true });
    expect(screen.queryByText(/by Al/)).not.toBeInTheDocument();
    expect(screen.getAllByText("Saving…").length).toBeGreaterThan(0);
  });

  it("omits the author when unknown", () => {
    renderSplit({ lastSavedLabel: "Last edited just now", updatedByName: null });
    expect(screen.getByText("Last edited just now")).toBeInTheDocument();
  });
});

describe("WikiEditSplit attachments", () => {
  it("renders file chips with size and a remove action for the uploader", () => {
    setAttachments([attachment({})]);
    renderSplit();
    expect(screen.getByText("Attachments")).toBeInTheDocument();
    expect(screen.getByText("whiteboard-sketch.png")).toBeInTheDocument();
    expect(screen.getByText("84 KB")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove attachment" })).toBeInTheDocument();
  });

  it("hides the remove action for a non-uploader non-admin", () => {
    setAttachments([attachment({ uploadedBy: "u9", uploadedByLabel: "Someone" })]);
    renderSplit();
    expect(screen.getByText("whiteboard-sketch.png")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove attachment" })).toBeNull();
  });

  it("renders nothing when the page has no attachments", () => {
    setAttachments([]);
    renderSplit();
    expect(screen.queryByText("Attachments")).toBeNull();
  });
});
