import { PanelRight } from "lucide-react";
import { useRevisions } from "../../lib/queries";
import { cn } from "../ui/cn";

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
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
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
}: EditSidebarProps) {
  const { data: revisions, isLoading, error } = useRevisions(slug, pageSlug, 20);

  if (collapsed) {
    return (
      <aside
        style={{
          width: 36,
          minWidth: 36,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          paddingTop: 8,
          background: "var(--lx-surface-elevated)",
          borderLeft: "1px solid var(--lx-border-default)",
        }}
      >
        <button
          type="button"
          className="w-7 h-7 p-0 flex items-center justify-center text-lx-text-muted hover:text-lx-text-primary rounded"
          onClick={onToggle}
          aria-label="Expand sidebar"
          title="Show page settings"
        >
          <PanelRight size={14} strokeWidth={1.5} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="wiki-edit-sidebar">
      <div className="wiki-edit-sidebar-header">
        <button
          type="button"
          className="w-7 h-7 p-0 flex items-center justify-center text-lx-text-muted hover:text-lx-text-primary mr-1"
          onClick={onToggle}
          aria-label="Collapse sidebar"
        >
          <PanelRight size={14} strokeWidth={1.5} />
        </button>
        <span className="text-base font-semibold font-body text-lx-text-primary">Page settings</span>
      </div>

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
              {revisions.map((rev, index) => (
                <div
                  key={rev.id}
                  className={cn("history-item", index === 0 && "active")}
                >
                  <div className="flex flex-col gap-1">
                    <span className="text-sm font-medium font-body text-lx-text-primary">
                      {formatRelative(rev.createdAt)}
                    </span>
                    {index === 0 && (
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
              ))}
            </div>
            <div className="history-actions">
              <button type="button" className="btn btn-primary flex-1">
                Restore
              </button>
              <button type="button" className="btn btn-ghost flex-1">
                Close preview
              </button>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
