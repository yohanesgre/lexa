// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Attachment } from "../../shared/types";

const state = vi.hoisted(() => ({
  currentUserId: "u1" as string | null,
  currentUserEmail: "me@example.com",
  role: "member" as string,
  attachments: [] as Attachment[],
}));

vi.mock("../lib/queries", () => ({
  useTaskAttachments: () => ({ data: state.attachments }),
  useUploadAttachment: () => ({ mutateAsync: vi.fn() }),
  useDeleteAttachment: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useProjectMembers: () => ({ data: [{ email: "me@example.com", name: "Me", role: state.role }] }),
  useSession: () => ({ data: { user: { id: state.currentUserId, email: state.currentUserEmail, name: "Me" } } }),
}));

import { AttachmentsPanel } from "./AttachmentsPanel";

function attachment(over: Partial<Attachment>): Attachment {
  return {
    id: "a1",
    projectId: "p1",
    taskId: "t1",
    wikiPageId: null,
    filename: "shot.png",
    mimeType: "image/png",
    sizeBytes: 1024,
    sha256: "abc",
    uploadedBy: "u1",
    uploadedByLabel: "Me",
    createdAt: "2026-05-13T00:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  state.currentUserId = "u1";
  state.currentUserEmail = "me@example.com";
  state.role = "member";
  state.attachments = [];
});

describe("AttachmentsPanel row actions", () => {
  it("renders a single direct Download glyph for forced-download rows", () => {
    state.attachments = [attachment({ id: "a2", filename: "data.csv", mimeType: "text/csv", uploadedBy: "u2" })];
    render(<AttachmentsPanel slug="demo" taskId="t1" />);
    expect(screen.getByLabelText("Download data.csv")).toBeInTheDocument();
    expect(screen.queryByLabelText("Actions for data.csv")).not.toBeInTheDocument();
  });

  it("hides Delete in the kebab for a non-uploader member", async () => {
    state.attachments = [attachment({ id: "a1", uploadedBy: "u9" })];
    const user = userEvent.setup();
    render(<AttachmentsPanel slug="demo" taskId="t1" />);
    await user.click(screen.getByLabelText("Actions for shot.png"));
    expect(await screen.findByRole("menuitem", { name: /download/i })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /delete/i })).not.toBeInTheDocument();
  });

  it("shows Delete for the uploader", async () => {
    state.attachments = [attachment({ id: "a1", uploadedBy: "u1" })];
    const user = userEvent.setup();
    render(<AttachmentsPanel slug="demo" taskId="t1" />);
    await user.click(screen.getByLabelText("Actions for shot.png"));
    expect(await screen.findByRole("menuitem", { name: /delete/i })).toBeInTheDocument();
  });

  it("shows Delete to a project admin for another member's file", async () => {
    state.role = "admin";
    state.attachments = [attachment({ id: "a1", uploadedBy: "u9" })];
    const user = userEvent.setup();
    render(<AttachmentsPanel slug="demo" taskId="t1" />);
    await user.click(screen.getByLabelText("Actions for shot.png"));
    expect(await screen.findByRole("menuitem", { name: /delete/i })).toBeInTheDocument();
  });
});
