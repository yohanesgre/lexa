import { useEffect, useMemo, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { lockScroll } from "../../lib/scroll-lock";
import { matchMedia } from "../../lib/viewport";
import type { AssistantChatThreadSummary } from "../../lib/api";
import { formatRelative } from "../../lib/relative-time";

// Transcribed from assistant-chat.html (Threads sidebar): persistent left
// column — collapse control + "New chat" pinned top (wiki arrangement), search
// below, thread rows ordered pinned-first then most-recent, active row
// accent-tinted. Rows are NAVIGATION-ONLY: a click opens the thread and the
// pin glyph shows the pinned state; pin/rename/delete live in the chat header.
// Searching splits into Pinned/Recent sections with client-side snippet
// bolding over the server-filtered (?q=) snippet. Collapsed (`open=false`)
// swaps the column for a 36px icon rail whose panel button restores it — the
// wiki sidebar's exact affordance, at every viewport width. Below 900px the
// expanded column is an overlay drawer — `open` toggles it, backdrop/Esc
// dismiss.
interface ThreadsSidebarProps {
  threads: AssistantChatThreadSummary[];
  activeChatId: string;
  search: string;
  onSearchChange: (q: string) => void;
  onSelect: (chatId: string) => void;
  onNewChat: () => void;
  open?: boolean | undefined;
  onToggle?: () => void;
  onClose?: () => void;
}

// Drawer dismissal is a <900px affordance — desktop collapse is owned by the
// sidebar's own collapse control. Safe under jsdom (no matchMedia → desktop).
function isMobileViewport(): boolean {
  return matchMedia("(max-width: 899.98px)");
}

function PinIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M12 17v5m-5-9.5A5.5 5.5 0 1 1 17 12.5" />
      <path d="M12 17a5 5 0 1 0-5-5" />
    </svg>
  );
}

// Client-side match highlighting over the server-returned snippet:
// case-insensitive occurrences of q get <mark>. No query → plain text.
function highlightSnippet(snippet: string, q: string): { text: string; mark: boolean; bold: boolean }[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [{ text: snippet, mark: false, bold: false }];
  const out: { text: string; mark: boolean; bold: boolean }[] = [];
  let rest = snippet;
  for (;;) {
    const idx = rest.toLowerCase().indexOf(needle);
    if (idx < 0) break;
    if (idx > 0) out.push({ text: rest.slice(0, idx), mark: false, bold: false });
    out.push({ text: rest.slice(idx, idx + needle.length), mark: true, bold: true });
    rest = rest.slice(idx + needle.length);
  }
  if (rest) out.push({ text: rest, mark: false, bold: false });
  return out.length > 0 ? out : [{ text: snippet, mark: false, bold: false }];
}

export function ThreadsSidebar({
  threads,
  activeChatId,
  search,
  onSearchChange,
  onSelect,
  onNewChat,
  open = true,
  onToggle,
  onClose,
}: ThreadsSidebarProps) {
  // Drawer Esc-dismiss (<900px). Thread actions — including the delete
  // dialog's own Escape handling — live in the header, not this sidebar.
  useEffect(() => {
    if (!open || !onClose) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && isMobileViewport()) onClose?.();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  // Empty query → flat list without section headers; a query splits the
  // server-filtered results into Pinned / Recent groups.
  const searching = search.trim().length > 0;
  const pinned = useMemo(() => threads.filter((t) => t.pinned), [threads]);
  const recent = useMemo(() => threads.filter((t) => !t.pinned), [threads]);

  const renderRow = (thread: AssistantChatThreadSummary) => {
    const isActive = thread.chatId === activeChatId;
    const title = thread.title ?? "New chat";
    return (
      <div key={thread.chatId} className={`thread-row ${isActive ? "active" : ""}`}>
        <div
          className="thread-row-main"
          role="button"
          tabIndex={0}
          onClick={() => {
            onSelect(thread.chatId);
            if (isMobileViewport()) onClose?.();
          }}
          onKeyDown={(e: ReactKeyboardEvent<HTMLDivElement>) => {
            if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
              if (e.key === " ") e.preventDefault();
              onSelect(thread.chatId);
              if (isMobileViewport()) onClose?.();
            }
          }}
        >
          {thread.pinned && (
            <span className="thread-pin" title="Pinned">
              <PinIcon />
            </span>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className={`text-sm truncate ${isActive ? "font-semibold" : "font-medium"} text-lx-text-primary`} style={{ lineHeight: "18px" }} title={title}>
              {title}
            </div>
            {searching && thread.snippet && (
              <div className="thread-snippet truncate">
                {highlightSnippet(thread.snippet, search).map((seg, i) =>
                  seg.mark ? <mark key={i}>{seg.text}</mark> : <span key={i}>{seg.text}</span>
                )}
              </div>
            )}
            <div className="thread-meta">{isActive ? "Active now" : formatRelative(thread.updatedAt)}</div>
          </div>
        </div>
      </div>
    );
  };

  // Scroll lock: plain function called from an effect (not a hook — rules
  // of hooks). The lock itself is gated on open + mobile viewport.
  useEffect(() => lockScroll(open && isMobileViewport()), [open]);

  // Collapsed: 36px icon rail with the restore control — wiki sidebar's
  // exact affordance (WikiLayout.tsx), kept at every viewport width so
  // re-expansion never depends on a control outside the sidebar.
  if (!open) {
    return (
      <aside className="threads-sidebar collapsed" aria-label="Threads">
        <button
          type="button"
          className="w-7 h-7 p-0 flex items-center justify-center text-lx-text-secondary hover:text-lx-text-primary rounded"
          onClick={onToggle}
          aria-label="Expand sidebar"
          title="Expand sidebar"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>
        </button>
      </aside>
    );
  }

  return (
    <>
      {open && <button type="button" className="threads-sidebar-backdrop" aria-label="Close threads" onClick={() => onClose?.()} />}
      <aside className={`threads-sidebar ${open ? "open" : "collapsed"}`} aria-label="Threads">
      <div className="threads-sidebar-header">
        {/* Collapse control lives INSIDE the sidebar (top of header) — mirrors wiki.html */}
        <div className="flex items-center gap-2">
          <button type="button" className="btn btn-ghost-accent btn-sm" style={{ flex: 1, justifyContent: "center" }} onClick={onNewChat}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 5v14m-7-7h14" /></svg>
            New chat
          </button>
          <button
            type="button"
            className="w-7 h-7 p-0 flex items-center justify-center text-lx-text-secondary hover:text-lx-text-primary flex-shrink-0 rounded"
            onClick={onToggle}
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>
          </button>
        </div>
        <input
          className="threads-search w-full"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search threads…"
          aria-label="Search threads"
        />
      </div>

      <div className="threads-sidebar-list">
        {threads.length === 0 ? (
          <div className="empty-box" style={{ margin: 8, border: "none", background: "transparent", padding: "24px 16px" }}>
            <span className="text-xs text-lx-text-secondary">{searching ? "No chats match your search" : "No threads yet — start a conversation"}</span>
          </div>
        ) : searching ? (
          <>
            {pinned.length > 0 && <div className="dropdown-label">Pinned</div>}
            {pinned.map(renderRow)}
            {pinned.length > 0 && recent.length > 0 && <div className="dropdown-label" style={{ marginTop: 6 }}>Recent</div>}
            {recent.map(renderRow)}
          </>
        ) : (
          threads.map(renderRow)
        )}
      </div>
    </aside>
    </>
  );
}
