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
      { text: "…cross-check the rollback ", bold: false },
      { text: "Runbook", bold: true },
      { text: " before Friday…", bold: false },
    ]);
  });

  it("handles multiple + adjacent matches and empty queries", () => {
    expect(highlightSnippet("aa aa", "aa")).toHaveLength(3);
    expect(highlightSnippet("plain text", "")).toEqual([{ text: "plain text", bold: false }]);
  });
});

describe("ThreadsSidebar", () => {
  it("renders rows with titles (null → New chat), relative time, active highlight, New chat + search pinned top", () => {
    setup();
    expect(screen.getByRole("button", { name: "New chat" })).toBeInTheDocument();
    expect(screen.getByLabelText("Search threads")).toBeInTheDocument();
    expect(screen.getByText("Payments migration questions")).toBeInTheDocument();
    // Null title renders the fallback.
    expect(screen.getByTitle("New chat")).toBeInTheDocument();
    // Active row carries the .active class and the Active now label; inactive shows relative time.
    const activeRow = rowFor("Payments migration questions");
    expect(activeRow.className).toContain("active");
    expect(activeRow.textContent).toContain("Active now");
    expect(rowFor("New chat").textContent).toMatch(/ago|yesterday/i);
  });

  it("empty state: No threads yet — start a conversation", () => {
    setup({ threads: [] });
    expect(screen.getByText("No threads yet — start a conversation")).toBeInTheDocument();
  });

  it("selecting a row calls onSelect then onClose; New chat calls onNewChat", () => {
    const onSelect = vi.fn();
    const onNewChat = vi.fn();
    const onClose = vi.fn();
    setup({ onSelect, onNewChat, onClose });
    fireEvent.click(screen.getByText("Payments migration questions"));
    expect(onSelect).toHaveBeenCalledWith("c1");
    expect(onClose).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(onNewChat).toHaveBeenCalled();
  });

  it("search input routes keystrokes to onSearchChange", () => {
    const onSearchChange = vi.fn();
    setup({ onSearchChange });
    fireEvent.change(screen.getByLabelText("Search threads"), { target: { value: "runbook" } });
    expect(onSearchChange).toHaveBeenCalledWith("runbook");
  });

  it("searching shows Pinned / Recent section headers; empty query hides them", () => {
    const base = { activeChatId: "c1", onSearchChange: vi.fn(), onSelect: vi.fn(), onNewChat: vi.fn(), onPinToggle: vi.fn(), onRename: vi.fn(), onDelete: vi.fn() };
    setup({ ...base, threads: THREADS, search: "runbook" });
    expect(screen.getByText("Pinned")).toBeInTheDocument();
    expect(screen.getByText("Recent")).toBeInTheDocument();
    cleanup();

    setup({ ...base, threads: THREADS, search: "" });
    expect(screen.queryByText("Pinned")).not.toBeInTheDocument();
    expect(screen.queryByText("Recent")).not.toBeInTheDocument();
  });

  it("snippet rows render under titles with the query bolded while searching; hidden when empty", () => {
    const threads: HeraldChatThreadSummary[] = [
      { ...THREADS[0], snippet: "…cross-check the rollback runbook before Friday…" },
    ];
    setup({ threads, search: "runbook" });
    const bolded = screen.getByText("runbook");
    expect(bolded.tagName).toBe("STRONG");
    expect(bolded.parentElement?.textContent).toBe("…cross-check the rollback runbook before Friday…");
    cleanup();

    setup({ threads, search: "" });
    expect(screen.queryByText(/cross-check/)).not.toBeInTheDocument();
  });

  it("pinned rows show a pin glyph; hover actions toggle pin with the inverted flag", () => {
    const onPinToggle = vi.fn().mockResolvedValue(undefined);
    setup({ onPinToggle });
    // c2 is pinned → pin glyph + Unpin action.
    const pinnedRow = rowFor("New chat");
    expect(pinnedRow.querySelector(".thread-pin")).not.toBeNull();
    fireEvent.click(within(pinnedRow).getByRole("button", { name: /unpin new chat/i }));
    expect(onPinToggle).toHaveBeenCalledWith("c2", false);

    // c1 is not pinned → Pin.
    fireEvent.click(within(rowFor("Payments migration questions")).getByRole("button", { name: /pin payments migration questions/i }));
    expect(onPinToggle).toHaveBeenCalledWith("c1", true);
  });

  it("rename inline: Rename swaps to input; Enter commits trimmed title; empty commit is a no-op; Esc cancels", async () => {
    const onRename = vi.fn().mockResolvedValue(undefined);
    setup({ onRename });
    fireEvent.click(within(rowFor("Payments migration questions")).getByRole("button", { name: /rename payments/i }));
    const input = screen.getByLabelText("Rename chat") as HTMLInputElement;
    expect(input.value).toBe("Payments migration questions");
    // Empty commit no-op.
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).not.toHaveBeenCalled();
    // Real commit trims.
    fireEvent.change(input, { target: { value: "  Rollback runbook draft  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onRename).toHaveBeenCalledWith("c1", "Rollback runbook draft"));
    // Esc cancels without committing.
    fireEvent.click(within(rowFor("Payments migration questions")).getByRole("button", { name: /rename payments/i }));
    const input2 = screen.getByLabelText("Rename chat");
    fireEvent.keyDown(input2, { key: "Escape" });
    expect(screen.queryByLabelText("Rename chat")).toBeNull();
  });

  it("delete flow: confirm dialog → onDelete; rejection keeps dialog open with the code", async () => {
    const onDelete = vi.fn().mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "HERALD_TASK_ACTIVE" }));
    setup({ onDelete });
    fireEvent.click(within(rowFor("Payments migration questions")).getByRole("button", { name: /delete payments/i }));
    expect(screen.getByRole("dialog", { name: /delete this chat/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^delete chat$/i }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("c1"));
    // 409 surfaced inline, dialog stays open.
    expect(await screen.findByText("HERALD_TASK_ACTIVE")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: /delete this chat/i })).toBeInTheDocument();

    // Second attempt succeeds and closes.
    onDelete.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole("button", { name: /^delete chat$/i }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /delete this chat/i })).toBeNull());
  });

  it("drawer Esc-dismiss fires onClose only outside inline edit/delete states", () => {
    const onClose = vi.fn();
    setup({ open: true, onClose });
    // While renaming, Esc cancels the rename instead of closing the drawer.
    fireEvent.click(within(rowFor("Payments migration questions")).getByRole("button", { name: /rename payments/i }));
    fireEvent.keyDown(screen.getByLabelText("Rename chat"), { key: "Escape" });
    expect(screen.queryByLabelText("Rename chat")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    // Free Esc closes the drawer.
    fireEvent.keyDown(document, { key: "Escape", bubbles: true });
    expect(onClose).toHaveBeenCalled();
  });

  it("collapse control sits inside the sidebar header; collapsed renders the restore rail (wiki affordance)", () => {
    const onToggle = vi.fn();
    setup({ open: true, onToggle, onClose: vi.fn() });
    const collapse = screen.getByRole("button", { name: "Collapse sidebar" });
    expect(collapse.closest(".threads-sidebar-header")).not.toBeNull();
    fireEvent.click(collapse);
    expect(onToggle).toHaveBeenCalledTimes(1);
    cleanup();

    setup({ open: false, onToggle, onClose: vi.fn() });
    expect(document.querySelector(".threads-sidebar.collapsed")).not.toBeNull();
    // Rail keeps the expand affordance; no drawer backdrop while collapsed.
    expect(screen.queryByLabelText("Close threads")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(onToggle).toHaveBeenCalledTimes(2);
  });
});
