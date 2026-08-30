// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Attachment } from "../../shared/types";
import { AttachmentsPanel } from "./AttachmentsPanel";

vi.mock("../lib/api", () => ({
  listTaskAttachments: vi.fn(),
  uploadAttachmentWithProgress: vi.fn(),
  deleteAttachment: vi.fn(),
}));

import * as api from "../lib/api";

const mockedApi = vi.mocked(api);

const PNG: Attachment = {
  id: "11111111-1111-4111-8111-111111111111",
  projectId: "p1",
  taskId: "t1",
  wikiPageId: null,
  filename: "board-crash-screenshot.png",
  mimeType: "image/png",
  sizeBytes: 1258291,
  sha256: "aa",
  uploadedBy: "u1",
  uploadedByLabel: "Alex Lin",
  createdAt: "2026-05-13T09:00:00Z",
};

const SVG: Attachment = {
  ...PNG,
  id: "22222222-2222-4222-8222-222222222222",
  filename: "emberfall-logo.svg",
  mimeType: "image/svg+xml",
  sizeBytes: 24576,
  uploadedByLabel: null,
  uploadedBy: "u9",
  createdAt: "2026-05-12T09:00:00Z",
};

const CSV: Attachment = {
  ...PNG,
  id: "33333333-3333-4333-8333-333333333333",
  filename: "playtest-metrics.csv",
  mimeType: "text/csv",
  sizeBytes: 98304,
  uploadedByLabel: "Maria Kim",
  createdAt: "2026-05-10T09:00:00Z",
};

function makeClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function renderPanel() {
  const qc = makeClient();
  return render(
    <QueryClientProvider client={qc}>
      <AttachmentsPanel slug="nimbus" taskId="t1" />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AttachmentsPanel", () => {
  it("renders header + empty state when no attachments exist", async () => {
    mockedApi.listTaskAttachments.mockResolvedValue({ data: [] });
    renderPanel();
    await waitFor(() => expect(screen.getByText("No attachments yet")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /upload/i })).toBeInTheDocument();
    expect(screen.getByText("Attachments")).toBeInTheDocument();
  });
  it("renders rows with meta (size · uploader · date) and inline-preview hrefs", async () => {
    // Server sends created_at ASC; panel displays newest first.
    mockedApi.listTaskAttachments.mockResolvedValue({ data: [CSV, SVG, PNG] });
    renderPanel();
    await waitFor(() => expect(screen.getByText("board-crash-screenshot.png")).toBeInTheDocument());

    // Newest-first order from the reversed ASC list.
    const names = screen.getAllByText(/screenshot|logo|metrics/).map((el) => el.textContent);
    expect(names.indexOf("board-crash-screenshot.png")).toBeLessThan(names.indexOf("emberfall-logo.svg"));
    expect(names.indexOf("emberfall-logo.svg")).toBeLessThan(names.indexOf("playtest-metrics.csv"));

    // Meta line: size · uploader label (fallback to id when null) · date
    expect(screen.getByText(/1.2 MB · Alex Lin · May 13/)).toBeInTheDocument();
    expect(screen.getByText(/24 KB · u9 · May 12/)).toBeInTheDocument();

    // Every row links to the attachment endpoint (inline disposition for
    // image/* + pdf comes from the server; the anchor is the affordance).
    const link = screen.getByRole("link", { name: "board-crash-screenshot.png" });
    expect(link).toHaveAttribute("href", "/api/attachments/11111111-1111-4111-8111-111111111111");
  });
});
