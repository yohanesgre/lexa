// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import type { HeraldChatThreadSummary } from "../../lib/api";
import { ThreadsSidebar, highlightSnippet } from "./ThreadsSidebar";

const THREADS: HeraldChatThreadSummary[] = [
  { chatId: "c1", title: "Payments migration questions", pinned: false, snippet: null, createdAt: "2026-08-22T09:00:00Z", updatedAt: "2026-08-22T10:00:00Z" },
  { chatId: "c2", title: null, pinned: true, snippet: null, createdAt: "2026-08-21T09:00:00Z", updatedAt: "2026-08-21T11:00:00Z" },
];

function setup(overrides?: Partial<Parameters<typeof ThreadsSidebar>[0]>) {
  const props = {
    threads: THREADS,
    activeChatId: "c1",
    search: "",
    onSearchChange: vi.fn(),
    onSelect: vi.fn(),
    onNewChat: vi.fn(),
    onPinToggle: vi.fn().mockResolvedValue(undefined),
    onRename: vi.fn().mockResolvedValue(undefined),
    onDelete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  render(<ThreadsSidebar {...props} />);
  return props;
}

function rowFor(title: string): HTMLElement {
  const list = document.querySelector(".threads-sidebar-list") as HTMLElement;
  return within(list).getByText(title).closest(".thread-row") as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom has no matchMedia — stub mobile so drawer-dismiss tests keep their
  // <900px semantics.
  window.matchMedia = ((query: string) => ({
    matches: query.includes("max-width"),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
});

describe("highlightSnippet", () => {
  it("bolds case-insensitive matches and keeps surrounding text plain", () => {
    expect(highlightSnippet("…cross-check the rollback Runbook before Friday…", "runbook")).toEqual([
      { text: "…cross-check the rollback ", bold: false, mark: false },
      { text: "Runbook", bold: true, mark: true },
      { text: " before Friday…", bold: false, mark: false },
    ]);
  });
  it("handles multiple + adjacent matches and empty queries", () => {
    expect(highlightSnippet("aa aa", "aa")).toHaveLength(3);
    expect(highlightSnippet("plain text", "")).toEqual([{ text: "plain text", bold: false, mark: false }]);
  });
});
