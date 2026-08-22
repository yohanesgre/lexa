// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import type { HeraldChatThreadSummary } from "../../lib/api";
import { ChatHistoryDropdown, highlightSnippet } from "./ChatHistoryDropdown";

const THREADS: HeraldChatThreadSummary[] = [
  { chatId: "c1", title: "Payments migration questions", pinned: false, snippet: null, createdAt: "2026-08-22T09:00:00Z", updatedAt: "2026-08-22T10:00:00Z" },
  { chatId: "c2", title: null, pinned: true, snippet: null, createdAt: "2026-08-21T09:00:00Z", updatedAt: "2026-08-21T11:00:00Z" },
];

function setup(overrides?: Partial<Parameters<typeof ChatHistoryDropdown>[0]>) {
  const props = {
    threads: THREADS,
    activeChatId: "c1",
    search: "",
    onSearchChange: vi.fn(),
    onSelect: vi.fn(),
    onNewChat: vi.fn(),
    onPinToggle: vi.fn().mockResolvedValue(undefined),
    onExport: vi.fn().mockResolvedValue(undefined),
    onRename: vi.fn().mockResolvedValue(undefined),
    onDelete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  render(<ChatHistoryDropdown {...props} />);
  return props;
}

function openPanel() {
  fireEvent.click(screen.getByRole("button", { name: /history/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
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

describe("ChatHistoryDropdown", () => {
  it("renders rows with titles (null → New chat), relative time, active tint + New chat pinned top", async () => {
    setup();
    openPanel();
    expect(screen.getByRole("button", { name: "New chat" })).toBeInTheDocument(); // pinned button
    expect(screen.getByText("Payments migration questions")).toBeInTheDocument();
    // Null title renders the fallback.
    expect(screen.getByTitle("New chat")).toBeInTheDocument();
    // Active row shows the accent tint + Active now label; inactive shows relative time.
    const activeRow = screen.getByText("Active now").closest("div[role='menuitem']") as HTMLElement;
    expect(activeRow.style.background).toContain("accent-subtle");
    expect(screen.getAllByText(/ago|yesterday/i).length).toBeGreaterThan(0);
  });

  it("empty state: No chats yet — start one below", () => {
    setup({ threads: [] });
    openPanel();
    expect(screen.getByText("No chats yet — start one below")).toBeInTheDocument();
  });

  it("selecting a row calls onSelect; New chat calls onNewChat; both close the panel", () => {
    const onSelect = vi.fn();
    const onNewChat = vi.fn();
    setup({ onSelect, onNewChat });
    const toggle = () => openPanel();
    toggle();
    fireEvent.click(screen.getByText("Payments migration questions"));
    expect(onSelect).toHaveBeenCalledWith("c1");
    expect(screen.queryByRole("menu")).toBeNull();

    toggle();
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(onNewChat).toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("search input sits directly below New chat and routes keystrokes to onSearchChange", () => {
    const onSearchChange = vi.fn();
    setup({ onSearchChange });
    openPanel();
    const input = screen.getByLabelText("Search chats") as HTMLInputElement;
    const panel = input.closest(".dropdown-menu") as HTMLElement;
    const newChat = screen.getByRole("button", { name: "New chat" });
    // Input renders after (below) the New chat button in DOM order.
    expect(panel.contains(newChat)).toBe(true);
    expect(newChat.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.change(input, { target: { value: "runbook" } });
    expect(onSearchChange).toHaveBeenCalledWith("runbook");
  });

  it("searching shows Pinned / Recent section headers", () => {
    setup({ search: "runbook" });
    openPanel();
    expect(screen.getByText("Pinned")).toBeInTheDocument();
    expect(screen.getByText("Recent")).toBeInTheDocument();
  });

  it("empty query hides both section headers and lists normally", () => {
    setup({ search: "" });
    openPanel();
    expect(screen.queryByText("Pinned")).not.toBeInTheDocument();
    expect(screen.queryByText("Recent")).not.toBeInTheDocument();
  });

  it("snippet rows render under titles with the query bolded while searching", () => {
    const threads: HeraldChatThreadSummary[] = [
      { ...THREADS[0], snippet: "…cross-check the rollback runbook before Friday…" },
    ];
    setup({ threads, search: "runbook" });
    openPanel();
    const bolded = screen.getByText("runbook");
    expect(bolded.tagName).toBe("STRONG");
    // The plain segments around it stay in the same snippet line.
    expect(bolded.parentElement?.textContent).toBe("…cross-check the rollback runbook before Friday…");
  });

  it("snippets are hidden when the query is empty", () => {
    const threads: HeraldChatThreadSummary[] = [
      { ...THREADS[0], snippet: "…cross-check the rollback runbook before Friday…" },
    ];
    setup({ threads, search: "" });
    openPanel();
    expect(screen.queryByText(/cross-check/)).not.toBeInTheDocument();
  });

  it("kebab gains Pin/Unpin + Export .md alongside Rename/Delete; toggling passes the inverted flag", async () => {
    const onPinToggle = vi.fn().mockResolvedValue(undefined);
    setup({ onPinToggle });
    openPanel();
    // c2 is pinned → Unpin.
    fireEvent.click(screen.getByRole("button", { name: /actions for new chat/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /unpin/i }));
    expect(onPinToggle).toHaveBeenCalledWith("c2", false);

    // c1 is not pinned → Pin.
    fireEvent.click(screen.getByRole("button", { name: /actions for payments migration questions/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^pin$/i }));
    expect(onPinToggle).toHaveBeenCalledWith("c1", true);
  });

  it("Export .md routes through onExport with the chatId", async () => {
    const onExport = vi.fn().mockResolvedValue(undefined);
    setup({ onExport });
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: /actions for payments migration questions/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /export \.md/i }));
    expect(onExport).toHaveBeenCalledWith("c1");
  });

  it("rename inline: kebab → Rename swaps to input; Enter commits trimmed title; empty commit is a no-op", async () => {
    const onRename = vi.fn().mockResolvedValue(undefined);
    setup({ onRename });
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: /actions for payments migration questions/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /rename/i }));
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
    fireEvent.click(screen.getByRole("button", { name: /actions for payments migration questions/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /rename/i }));
    const input2 = screen.getByLabelText("Rename chat");
    fireEvent.keyDown(input2, { key: "Escape" });
    expect(screen.queryByLabelText("Rename chat")).toBeNull();
  });

  it("delete flow: confirm dialog → onDelete; rejection keeps dialog open with the code", async () => {
    const onDelete = vi.fn().mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "HERALD_TASK_ACTIVE" }));
    setup({ onDelete });
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: /actions for payments migration questions/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /delete/i }));
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
});
