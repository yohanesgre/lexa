import { useEffect, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Plus } from "lucide-react";
import { lockScroll } from "../../lib/scroll-lock";
import { matchMedia } from "../../lib/viewport";
import { useOverlayFocusTrap } from "../../lib/sidebar-state";
import type { AssistantChatThreadSummary } from "../../lib/api";
import { formatRelative } from "../../lib/relative-time";

// The chat surface pane (The One Left System Rule): docked under the cap band
// against the rail at ≥1024px (280px ≥1440, 260px below), a 288px drawer under
// the band over the scrim below that. It is docked or absent — no collapsed
// stub band — and the cap band's labelled `Threads` toggle owns open/close, so
// the pane carries no collapse control of its own. Interior shares the rail's
// row geometry: 8px symmetric insets, 4px gaps, a 36px head row (`THREADS` +
// count), a 36px `New chat` ghost button, a 36px search field, then the rows.
// Rows are NAVIGATION-ONLY: a click opens the thread and the pin glyph shows
// the pinned state; pin/rename/delete live in the chat header. Searching splits
// into Pinned/Recent sections with client-side snippet bolding over the
// server-filtered (?q=) snippet.
interface ThreadsSidebarProps {
  threads: AssistantChatThreadSummary[];
  activeChatId: string;
  search: string;
  onSearchChange: (q: string) => void;
  onSelect: (chatId: string) => void;
  onNewChat: () => void;
  open?: boolean | undefined;
  onClose?: () => void;
  // The list read failed — render the design's danger void with Retry instead
  // of the empty state (D4; DESIGN.md surface-pane states).
  error?: boolean | undefined;
  onRetry?: (() => void) | undefined;
}

// Escape and the scrim dismiss the drawer only; at ≥1024px the pane is docked
// and clicking a row never closes it. Safe under jsdom (no matchMedia → docked).
function isDrawerViewport(): boolean {
  return matchMedia("(max-width: 1023.98px)");
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
  onClose,
  error = false,
  onRetry,
}: ThreadsSidebarProps) {
  const panelRef = useRef<HTMLElement>(null);
  const overlayActive = open && isDrawerViewport();
  useOverlayFocusTrap(overlayActive, panelRef);
  // Drawer Esc-dismiss (<1024px). Thread actions — including the delete
  // dialog's own Escape handling — live in the header, not this pane.
  useEffect(() => {
    if (!open || !onClose) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && isDrawerViewport()) onClose?.();
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
            if (isDrawerViewport()) onClose?.();
          }}
          onKeyDown={(e: ReactKeyboardEvent<HTMLDivElement>) => {
            if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
              if (e.key === " ") e.preventDefault();
              onSelect(thread.chatId);
              if (isDrawerViewport()) onClose?.();
            }
          }}
        >
          {thread.pinned && (
            <span className="thread-pin" title="Pinned">
              <PinIcon />
            </span>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className={`thread-title${isActive ? " is-active" : ""}`} title={title}>
              {title}
            </div>
            {searching && thread.snippet && (
              <div className="thread-snippet">
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

  // Body scroll locks only while the drawer covers the chat.
  useEffect(() => lockScroll(open && isDrawerViewport()), [open]);

  return (
    <>
      {open && <button type="button" className="threads-sidebar-backdrop" aria-label="Close threads" onClick={() => onClose?.()} />}
      <aside ref={panelRef} id="threads-pane" className={`threads-sidebar${open ? " open" : ""}`} aria-label="Threads" role={overlayActive ? "dialog" : undefined} aria-modal={overlayActive || undefined} tabIndex={-1}>
        <div className="pane-top">
          <div className="pane-head">
            <span className="pane-head-label">Threads</span>
            <span className="pane-head-count">{String(threads.length).padStart(3, "0")}</span>
          </div>
          <div className="pane-search">
            <input
              className="threads-search pane-search-input"
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Search threads…"
              aria-label="Search threads"
            />
          </div>
          <button type="button" className="btn btn-ghost pane-action" onClick={onNewChat}>
            <Plus size={13} strokeWidth={1.5} aria-hidden="true" />
            New chat
          </button>
        </div>

        <div className="threads-sidebar-list">
          {error ? (
            <div className="pane-error">
              <span className="pane-void-title">Threads could not be read.</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
                Retry
              </button>
            </div>
          ) : threads.length === 0 ? (
            <div className="pane-void">
              <span>{searching ? "No chats match your search" : "No threads yet — start a conversation"}</span>
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
