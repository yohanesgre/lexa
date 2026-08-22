import { useEffect, useMemo, useRef, useState } from "react";
import type { HeraldChatThreadSummary } from "../../lib/api";
import { formatRelative } from "../../lib/relative-time";
import { Menu } from "../ui/Menu";

// Transcribed from herald-chat-history.html + herald-chat-upgrades.html:
// 320px dropdown panel — "New chat" pinned top, search input directly below
// it (server-side ?q= filter, debounced upstream), Pinned section above
// Recent when searching, snippet rows with the query bolded client-side,
// rows (title truncate · relative time · kebab Pin/Unpin + Export .md +
// Rename/Delete), active thread accent tint + semibold, rename-inline
// (input + ✓/✕, Enter commits Esc cancels, empty-commit no-op), delete
// confirm dialog, empty-box state.
interface ChatHistoryDropdownProps {
  threads: HeraldChatThreadSummary[];
  activeChatId: string;
  search: string;
  onSearchChange: (q: string) => void;
  onSelect: (chatId: string) => void;
  onNewChat: () => void;
  onPinToggle: (chatId: string, pinned: boolean) => Promise<unknown> | unknown;
  onExport: (chatId: string) => Promise<unknown> | unknown;
  onRename: (chatId: string, title: string) => Promise<unknown> | unknown;
  onDelete: (chatId: string) => Promise<unknown> | unknown;
}

function KebabIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <circle cx="12" cy="5" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="12" cy="19" r="1.5" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M12 17v5m-5-9.5A5.5 5.5 0 1 1 17 12.5" />
      <path d="M12 17a5 5 0 1 0-5-5" />
    </svg>
  );
}

function ExportIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function RenameIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

// Client-side match highlighting over the server-returned snippet:
// case-insensitive occurrences of q get <strong>. No query → plain text.
export function highlightSnippet(snippet: string, q: string): { text: string; bold: boolean }[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [{ text: snippet, bold: false }];
  const out: { text: string; bold: boolean }[] = [];
  let rest = snippet;
  for (;;) {
    const idx = rest.toLowerCase().indexOf(needle);
    if (idx < 0) break;
    if (idx > 0) out.push({ text: rest.slice(0, idx), bold: false });
    out.push({ text: rest.slice(idx, idx + needle.length), bold: true });
    rest = rest.slice(idx + needle.length);
  }
  if (rest) out.push({ text: rest, bold: false });
  return out.length > 0 ? out : [{ text: snippet, bold: false }];
}

export function ChatHistoryDropdown({
  threads,
  activeChatId,
  search,
  onSearchChange,
  onSelect,
  onNewChat,
  onPinToggle,
  onExport,
  onRename,
  onDelete,
}: ChatHistoryDropdownProps) {
  const [open, setOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [confirmTarget, setConfirmTarget] = useState<HeraldChatThreadSummary | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onMouseDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

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
        role="menuitem"
        tabIndex={0}
        onClick={() => {
          onSelect(thread.chatId);
          setOpen(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            onSelect(thread.chatId);
            setOpen(false);
          }
        }}
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 8,
          padding: "8px 10px",
          cursor: "pointer",
          ...(isActive ? { background: "var(--lx-bg-accent-subtle)" } : {}),
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className={`text-sm truncate ${isActive ? "font-semibold" : "font-medium"} text-lx-text-primary`} style={{ lineHeight: "18px" }} title={title}>
            {title}
          </div>
          {searching && thread.snippet && (
            <div className="font-micro text-2xs text-lx-text-muted truncate" style={{ lineHeight: "14px" }}>
              {highlightSnippet(thread.snippet, search).map((seg, i) =>
                seg.bold ? <strong key={i}>{seg.text}</strong> : <span key={i}>{seg.text}</span>
              )}
            </div>
          )}
          <div className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">
            {isActive ? "Active now" : formatRelative(thread.updatedAt)}
          </div>
        </div>
        <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <Menu
            trigger={({ toggle }) => (
              <button type="button" className="icon-btn" title="Thread actions" aria-label={`Actions for ${title}`} onClick={toggle}>
                <KebabIcon />
              </button>
            )}
          >
            <button type="button" className="menu-item" role="menuitem" onClick={() => void onPinToggle(thread.chatId, !thread.pinned)}>
              <PinIcon />
              {thread.pinned ? "Unpin" : "Pin"}
            </button>
            <button type="button" className="menu-item" role="menuitem" onClick={() => void onExport(thread.chatId)}>
              <ExportIcon />
              Export .md
            </button>
            <div className="menu-separator" />
            <button type="button" className="menu-item" role="menuitem" onClick={() => startRename(thread)}>
              <RenameIcon />
              Rename
            </button>
            <button
              type="button"
              className="menu-item danger"
              role="menuitem"
              onClick={() => {
                setConfirmTarget(thread);
                setConfirmError(null);
              }}
            >
              <DeleteIcon />
              Delete
            </button>
          </Menu>
        </div>
      </div>
    );
  };

  return (
    <div ref={containerRef} style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        style={open ? { borderColor: "var(--lx-border-focus)" } : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
        History
      </button>

      {open && (
        <div className="dropdown-menu" role="menu" style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, width: 320, zIndex: 60 }}>
          <div style={{ padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
            <button
              type="button"
              className="btn btn-ghost-accent btn-sm w-full"
              style={{ justifyContent: "center" }}
              onClick={() => {
                setOpen(false);
                onNewChat();
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 5v14m-7-7h14" /></svg>
              New chat
            </button>
            <input
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Search chats…"
              aria-label="Search chats"
              style={{ height: 26, padding: "0 8px", fontSize: 12, fontFamily: "var(--lx-font-body)", color: "var(--lx-text-primary)", background: "var(--lx-surface-input)", border: "1px solid var(--lx-border-default)", borderRadius: 4 }}
            />
          </div>
          <div className="dropdown-separator" />

          {threads.length === 0 ? (
            <div className="empty-box" style={{ padding: "24px 16px" }}>
              <span className="text-xs text-lx-text-secondary">{searching ? "No chats match your search" : "No chats yet — start one below"}</span>
            </div>
          ) : searching ? (
            <>
              {pinned.length > 0 && <div className="dropdown-label">Pinned</div>}
              {pinned.map(renderRow)}
              {pinned.length > 0 && recent.length > 0 && <div className="dropdown-separator" />}
              {recent.length > 0 && <div className="dropdown-label">Recent</div>}
              {recent.map(renderRow)}
            </>
          ) : (
            threads.map(renderRow)
          )}
        </div>
      )}

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
    </div>
  );
}
