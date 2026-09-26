import { useEffect, useRef, useState } from "react";
import { Settings, X } from "lucide-react";
import { useRevisions } from "../../lib/queries";
import { useOverlayFocusTrap } from "../../lib/sidebar-state";
import { lockScroll } from "../../lib/scroll-lock";
import { useMobilePanel } from "../../lib/viewport";
import { cn } from "../ui/cn";
import { parseApiDate } from "../../lib/date";

const DELAY_OPTIONS = [500, 800, 1500, 3000];
const PANEL_ID = "wiki-page-settings";

function formatRelative(iso: string): string {
  const then = parseApiDate(iso).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - then);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  return `${days} days ago`;
}

interface RevisionItemProps {
  rev: { id: string; createdAt: string; saveType: string };
  isActive: boolean;
  onSelectRevision: (id: string) => void;
}

function RevisionItem({ rev, isActive, onSelectRevision }: RevisionItemProps) {
  return (
    <button
      type="button"
      className={cn("history-item", isActive && "active")}
      onClick={() => onSelectRevision(rev.id)}
    >
      <span className="flex flex-col gap-1" style={{ alignItems: "flex-start" }}>
        <span className={cn("text-sm font-body text-lx-text-primary", isActive && "font-medium")}>
          {formatRelative(rev.createdAt)}
        </span>
        {isActive && (
          <span className="font-micro text-2xs text-lx-text-warning uppercase tracking-[0.04em]">
            Previewing
          </span>
        )}
      </span>
      <span
        className={cn(
          "history-badge",
          rev.saveType === "autosave" ? "history-badge-auto" : "history-badge-manual"
        )}
      >
        {rev.saveType}
      </span>
    </button>
  );
}

interface PageSettingsPanelProps {
  slug: string;
  pageSlug: string;
  autosaveEnabled: boolean;
  autosaveDelay: number;
  onAutosaveChange: (enabled: boolean) => void;
  onDelayChange: (delay: number) => void;
  selectedRevisionId: string | null;
  onSelectRevision: (id: string) => void;
  onRestore: (id: string) => void;
  onClosePreview: () => void;
  restoring?: boolean | undefined;
}

export function PageSettingsPanel({
  slug,
  pageSlug,
  autosaveEnabled,
  autosaveDelay,
  onAutosaveChange,
  onDelayChange,
  selectedRevisionId,
  onSelectRevision,
  onRestore,
  onClosePreview,
  restoring,
}: PageSettingsPanelProps) {
  const [open, setOpen] = useState(false);
  const isMobile = useMobilePanel();
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const suppressReturnFocusRef = useRef(false);
  useOverlayFocusTrap(open, panelRef, suppressReturnFocusRef);

  const { data: revisions, isLoading, error, refetch } = useRevisions(slug, pageSlug, 20);
  const activeRevisionId = selectedRevisionId ?? revisions?.[0]?.id ?? null;

  useEffect(() => {
    if (!open) return;
    function handleMouseDown(event: MouseEvent) {
      const target = event.target as Node | null;
      if (anchorRef.current && target && !anchorRef.current.contains(target)) {
        suppressReturnFocusRef.current = true;
        setOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(() => lockScroll(open && isMobile), [open, isMobile]);

  useEffect(() => {
    if (!isMobile) setOpen(false);
  }, [isMobile]);

  const selectRevision = (id: string) => {
    onSelectRevision(id);
    if (isMobile) setOpen(false);
  };

  let historyBody: React.ReactNode;
  if (isLoading) {
    historyBody = (
      <div className="history-list">
        <div className="skeleton" style={{ height: 34 }} />
        <div className="skeleton" style={{ height: 34 }} />
        <div className="skeleton" style={{ height: 34 }} />
      </div>
    );
  } else if (error) {
    historyBody = (
      <div className="tasks-error">
        <div className="tasks-error-title">Failed to load versions</div>
        <div className="tasks-error-sub">The revisions query failed to load</div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void refetch()}>
          Retry
        </button>
      </div>
    );
  } else if (!revisions || revisions.length === 0) {
    historyBody = (
      <div className="history-list">
        <div className="history-empty">No previous versions yet.</div>
      </div>
    );
  } else {
    historyBody = (
      <>
        <div className="history-list">
          {revisions.map((rev) => (
            <RevisionItem
              key={rev.id}
              rev={rev}
              isActive={rev.id === activeRevisionId}
              onSelectRevision={selectRevision}
            />
          ))}
        </div>
        <div className="history-actions">
          <button
            type="button"
            className="btn btn-primary"
            style={{ flex: 1 }}
            disabled={restoring || selectedRevisionId === null}
            onClick={() => selectedRevisionId && onRestore(selectedRevisionId)}
          >
            {restoring ? "Restoring…" : "Restore"}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ flex: 1 }}
            disabled={activeRevisionId === null}
            onClick={onClosePreview}
          >
            Close preview
          </button>
        </div>
      </>
    );
  }

  const blocks = (
    <>
      <div className="wiki-panel-block">
        <div className="flex items-center justify-between mb-2">
          <span className="wiki-panel-block-title" style={{ marginBottom: 0 }}>
            Autosave
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={autosaveEnabled}
            aria-label="Autosave"
            className={cn("toggle-switch", autosaveEnabled && "is-on")}
            onClick={() => onAutosaveChange(!autosaveEnabled)}
          />
        </div>
        {autosaveEnabled && (
          <div className="delay-selector">
            {DELAY_OPTIONS.map((ms) => (
              <button
                key={ms}
                type="button"
                className={cn("delay-btn", autosaveDelay === ms && "is-active")}
                aria-pressed={autosaveDelay === ms}
                onClick={() => onDelayChange(ms)}
              >
                {ms} ms
              </button>
            ))}
          </div>
        )}
        <p className="text-xs text-lx-text-secondary font-body leading-[18px]" style={{ marginTop: 8 }}>
          {autosaveEnabled ? "Automatically saves changes while you type." : "Autosave is disabled."}
        </p>
      </div>

      <div className="wiki-panel-block">
        <span className="wiki-panel-block-title">Version History</span>
        {historyBody}
      </div>
    </>
  );

  return (
    <div className="wiki-settings-anchor" ref={anchorRef}>
      <button
        type="button"
        className="btn btn-ghost btn-sm wiki-settings-btn"
        aria-label="Page settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={PANEL_ID}
        onClick={() => setOpen((value) => !value)}
      >
        <Settings size={14} strokeWidth={1.5} />
        <span className="wiki-settings-btn-label">Page settings</span>
      </button>

      {open && isMobile && (
        <>
          <button
            type="button"
            className="wiki-sheet-scrim"
            aria-label="Close page settings"
            onClick={() => setOpen(false)}
          />
          <div
            id={PANEL_ID}
            ref={panelRef}
            className="wiki-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="Page settings"
          >
            <div className="wiki-sheet-grip" />
            <div className="wiki-sheet-header">
              <span className="wiki-panel-title">Page settings</span>
              <button
                type="button"
                className="icon-btn"
                aria-label="Close"
                onClick={() => setOpen(false)}
                style={{ width: 28, height: 28 }}
              >
                <X size={14} strokeWidth={1.5} />
              </button>
            </div>
            <div className="wiki-sheet-body">{blocks}</div>
          </div>
        </>
      )}

      {open && !isMobile && (
        <div
          id={PANEL_ID}
          ref={panelRef}
          className="wiki-popover wiki-settings-panel"
          role="dialog"
          aria-label="Page settings"
        >
          {blocks}
        </div>
      )}
    </div>
  );
}
