// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { WikiPage } from "../../../shared/types";

vi.mock("../tiptap-render", () => ({
  renderDoc: () => null,
  extractHeadings: () => [{ level: 2, text: "Basics", id: "basics" }],
  slugifyHeading: (value: string) => value,
}));

// Pin the lazy workspace in a suspended state so the Suspense fallback is
// observable: the chunk never resolves, exactly like a slow network fetch.
vi.mock("./WikiEditWorkspace", () => {
  const never = new Promise<void>(() => {});
  return {
    WikiEditWorkspace: () => {
      throw never;
    },
  };
});

vi.mock("../document/SourcesSection", () => ({ SourcesSection: () => null }));
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

beforeEach(() => {
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

describe("WikiPageViewer lazy edit workspace", () => {
  it("keeps the read view as the Suspense fallback while the chunk loads", () => {
    render(<WikiPageViewer slug="demo" page={PAGE} pages={[PAGE]} />);
    expect(document.querySelector(".wiki-read-area")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    // The workspace never resolves; the read view must remain mounted rather
    // than the content area blanking out.
    expect(document.querySelector(".wiki-read-area")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
  });
});
