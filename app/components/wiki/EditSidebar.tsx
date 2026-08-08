import { useRevisions } from "../../lib/queries";
import { cn } from "../ui/cn";
import { WikiSidebar } from "./WikiSidebar";
import { parseApiDate } from "../../lib/date";

const DELAY_OPTIONS = [500, 800, 1500, 3000];

interface EditSidebarProps {
  slug: string;
  pageSlug: string;
  autosaveEnabled: boolean;
  autosaveDelay: number;
  onAutosaveChange: (enabled: boolean) => void;
  onDelayChange: (delay: number) => void;
  collapsed: boolean;
  onToggle: () => void;
  selectedRevisionId: string | null;
  onSelectRevision: (id: string) => void;
  onRestore: (id: string) => void;
  onClosePreview: () => void;
  restoring?: boolean;
}

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

export function EditSidebar({
  slug,
  pageSlug,
  autosaveEnabled,
  autosaveDelay,
  onAutosaveChange,
  onDelayChange,
  collapsed,
  onToggle,
  selectedRevisionId,
  onSelectRevision,
  onRestore,
  onClosePreview,
  restoring,
}: EditSidebarProps) {
  const { data: revisions, isLoading, error } = useRevisions(slug, pageSlug, 20);
  const activeRevisionId = selectedRevisionId ?? revisions?.[0]?.id ?? null;

  return (
    <WikiSidebar title="Page settings" collapsed={collapsed} onToggle={onToggle}>
      <div className="sidebar-section">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-medium font-body text-lx-text-primary">Autosave</span>
          <button
            type="button"
            className={cn("toggle-switch", autosaveEnabled && "is-on")}
            onClick={() => onAutosaveChange(!autosaveEnabled)}
            aria-label={autosaveEnabled ? "Autosave on" : "Autosave off"}
          />
        </div>

        {autosaveEnabled && (
          <div className="mb-3">
            <span className="prop-label block mb-1.5">Delay</span>
            <div className="delay-selector">
              {DELAY_OPTIONS.map((ms) => (
                <button
                  key={ms}
                  type="button"
                  className={cn("delay-btn", autosaveDelay === ms && "is-active")}
                  onClick={() => onDelayChange(ms)}
                >
                  {ms}ms
                </button>
              ))}
            </div>
          </div>
        )}

        <p className="text-xs text-lx-text-secondary font-body leading-[18px]">
          {autosaveEnabled
            ? "Automatically saves changes while you type."
            : "Autosave is disabled."}
        </p>
      </div>

      <div className="sidebar-section flex-1 flex flex-col">
        <span className="sidebar-section-title">Version History</span>

        {isLoading && <div className="text-xs text-lx-text-muted py-2">Loading versions…</div>}

        {error && (
          <div className="text-xs text-lx-text-danger py-2">Failed to load versions</div>
        )}

        {!isLoading && !error && revisions && revisions.length === 0 && (
          <div className="history-empty">No previous versions yet.</div>
        )}

        {!isLoading && !error && revisions && revisions.length > 0 && (
          <>
            <div className="history-list">
              {revisions.map((rev) => {
                const isActive = rev.id === activeRevisionId;
                return (
                  <div
                    key={rev.id}
                    className={cn("history-item", isActive && "active")}
                    onClick={() => onSelectRevision(rev.id)}
                  >
                    <div className="flex flex-col gap-1">
                      <span className={cn("text-sm font-body text-lx-text-primary", isActive && "font-medium")}>
                        {formatRelative(rev.createdAt)}
                      </span>
                      {isActive && (
                        <span className="font-micro text-2xs text-lx-text-warning uppercase tracking-[0.04em]">
                          Previewing
                        </span>
                      )}
                    </div>
                    <span
                      className={cn(
                        "history-badge",
                        rev.saveType === "autosave" ? "history-badge-auto" : "history-badge-manual"
                      )}
                    >
                      {rev.saveType}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="history-actions">
              <button
                type="button"
                className="btn btn-primary flex-1"
                disabled={restoring || selectedRevisionId === null}
                onClick={() => selectedRevisionId && onRestore(selectedRevisionId)}
              >
                Restore
              </button>
              <button
                type="button"
                className="btn btn-ghost flex-1"
                disabled={selectedRevisionId === null}
                onClick={onClosePreview}
              >
                Close preview
              </button>
            </div>
          </>
        )}
      </div>
    </WikiSidebar>
  );
}
