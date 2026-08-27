import { useEffect, useMemo, useState } from "react";
import { useScrollLock } from "../../lib/scroll-lock";
import type { HeraldChatThreadSummary } from "../../lib/api";
import { formatRelative } from "../../lib/relative-time";

// Transcribed from herald-chat.html (Threads sidebar) +
// herald-chat-upgrades.html: persistent left column — collapse control +
// "New chat" pinned top (wiki arrangement), search below, thread rows ordered
// pinned-first then most-recent, active row accent-tinted. Rows carry
// hover/focus-within-revealed inline actions (Pin/Unpin · Rename inline ·
// Delete confirm); searching splits into Pinned/Recent sections with
// client-side snippet bolding over the server-filtered (?q=) snippet.
// Collapsed (`open=false`) swaps the column for a 36px icon rail whose panel
// button restores it — the wiki sidebar's exact affordance, at every viewport
// width. Below 900px the expanded column is an overlay drawer — `open`
// toggles it, backdrop/Esc dismiss.
interface ThreadsSidebarProps {
  threads: HeraldChatThreadSummary[];
  activeChatId: string;
  search: string;
  onSearchChange: (q: string) => void;
  onSelect: (chatId: string) => void;
  onNewChat: () => void;
  onPinToggle: (chatId: string, pinned: boolean) => Promise<unknown> | unknown;
  onRename: (chatId: string, title: string) => Promise<unknown> | unknown;
  onDelete: (chatId: string) => Promise<unknown> | unknown;
  open?: boolean | undefined;
  onToggle?: () => void;
  onClose?: () => void;
}

// Drawer dismissal is a <900px affordance — desktop collapse is owned by the
// header toggle alone. Safe under jsdom (no matchMedia → desktop).
function isMobileViewport(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(max-width: 899.98px)").matches;
}

function PinIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M12 17v5m-5-9.5A5.5 5.5 0 1 1 17 12.5" />
      <path d="M12 17a5 5 0 1 0-5-5" />
    </svg>
  );
}

function RenameIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

// Client-side match highlighting over the server-returned snippet:
// case-insensitive occurrences of q get <mark>. No query → plain text.
export function highlightSnippet(snippet: string, q: string): { text: string; mark: boolean; bold: boolean }[] {
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
  onPinToggle,
  onRename,
  onDelete,
  open = true,
  onToggle,
  onClose,
}: ThreadsSidebarProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [confirmTarget, setConfirmTarget] = useState<HeraldChatThreadSummary | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Drawer Esc-dismiss (<900px). Skipped while an inline edit or the delete
  // dialog owns Escape.
  useEffect(() => {
    if (!open || !onClose) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && isMobileViewport() && renamingId === null && confirmTarget === null) onClose?.();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose, renamingId, confirmTarget]);

  const startRename = (thread: HeraldChatThreadSummary) => {
    setRenamingId(thread.chatId);
    setRenameDraft(thread.title ?? "");
  };

  const commitRename = () => {
    if (!renamingId) return;
    const title = renameDraft.trim();
    if (!title) return; // empty/whitespace commit is a no-op — row stays in edit mode
    void Promise.resolve(onRename(renamingId, title)).finally(() => setRenamingId(null));
  };

  const cancelRename = () => setRenamingId(null);

  const confirmDelete = async () => {
    if (!confirmTarget) return;
    setDeleting(true);
    try {
      await onDelete(confirmTarget.chatId);
      setConfirmTarget(null);
      setConfirmError(null);
    } catch (err) {
      // HERALD_TASK_ACTIVE etc — dialog stays open, code surfaced inline.
      const code = (err as { code?: string }).code;
      setConfirmError(code ?? (err as Error).message ?? "Delete failed");
    } finally {
      setDeleting(false);
    }
  };

  // Empty query → flat list without section headers; a query splits the
  // server-filtered results into Pinned / Recent groups.
  const searching = search.trim().length > 0;
  const pinned = useMemo(() => threads.filter((t) => t.pinned), [threads]);
  const recent = useMemo(() => threads.filter((t) => !t.pinned), [threads]);

  const renderRow = (thread: HeraldChatThreadSummary) => {
    const isActive = thread.chatId === activeChatId;
    const title = thread.title ?? "New chat";
    if (renamingId === thread.chatId) {
      return (
        <div key={thread.chatId} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", background: "var(--lx-surface-selected)", borderRadius: 4 }}>
          <input
            autoFocus
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") cancelRename();
            }}
            style={{ flex: 1, minWidth: 0, height: 26, padding: "0 8px", fontSize: 13, fontFamily: "var(--lx-font-body)", color: "var(--lx-text-primary)", background: "var(--lx-surface-input)", border: "1px solid var(--lx-border-focus)", borderRadius: 4 }}
            aria-label="Rename chat"
          />
          <button type="button" className="btn btn-primary btn-icon-sm" title="Commit rename (Enter)" aria-label="Commit rename" onClick={commitRename}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M20 6L9 17l-5-5" /></svg>
          </button>
          <button type="button" className="btn btn-ghost btn-icon-sm" title="Cancel rename (Esc)" aria-label="Cancel rename" onClick={cancelRename}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>
      );
    }
    return (
      <div
        key={thread.chatId}
        role="button"
        tabIndex={0}
        className={`thread-row ${isActive ? "active" : ""}`}
        onClick={() => {
          onSelect(thread.chatId);
          if (isMobileViewport()) onClose?.();
        }}
        onKeyDown={(e) => {
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
        <div className="thread-row-actions" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <button type="button" className="icon-btn" title={thread.pinned ? "Unpin" : "Pin"} aria-label={thread.pinned ? `Unpin ${title}` : `Pin ${title}`} onClick={() => void onPinToggle(thread.chatId, !thread.pinned)}>
            <PinIcon />
          </button>
          <button type="button" className="icon-btn" title="Rename" aria-label={`Rename ${title}`} onClick={() => startRename(thread)}>
            <RenameIcon />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Delete"
            aria-label={`Delete ${title}`}
            onClick={() => {
              setConfirmTarget(thread);
              setConfirmError(null);
            }}
          >
            <DeleteIcon />
          </button>
        </div>
      </div>
    );
  };

  useEffect(() => {
    if (!open || !isMobileViewport()) return;
    return useScrollLock(true);
  }, [open]);

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

      {/* Delete confirm — reset-confirm dialog anatomy from herald-chat.html */}
      {confirmTarget && (
        <>
          <button type="button" className="slideover-overlay" style={{ zIndex: 90 }} aria-label="Close" onClick={() => !deleting && setConfirmTarget(null)} />
          <div style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, pointerEvents: "none" }}>
            <dialog open className="dialog dialog-enter pointer-events-auto" aria-modal="true" aria-label="Delete this chat?">
              <div className="flex items-center justify-between mb-2">
                <span className="font-display text-base font-semibold text-lx-text-primary">Delete this chat?</span>
                <button type="button" className="btn btn-ghost btn-icon-sm" aria-label="Cancel delete" disabled={deleting} onClick={() => setConfirmTarget(null)}>✕</button>
              </div>
              <p className="text-xs text-lx-text-secondary" style={{ lineHeight: "18px" }}>
                Deletes "<span className="font-mono">{confirmTarget.title ?? "New chat"}</span>" — both turns and attachments. This cannot be undone.
              </p>
              {confirmError && (
                <div className="notice notice-danger mt-3">
                  <span className="font-mono text-xs font-medium">{confirmError}</span>
                </div>
              )}
              <div className="flex items-center justify-end gap-2 mt-4">
                <button type="button" className="btn btn-ghost btn-sm" disabled={deleting} onClick={() => setConfirmTarget(null)}>Cancel</button>
                <button type="button" className="btn btn-danger-solid btn-sm" disabled={deleting} onClick={() => void confirmDelete()}>
                  {deleting ? "Deleting…" : "Delete chat"}
                </button>
              </div>
            </dialog>
          </div>
        </>
      )}
    </aside>
    </>
  );
}
