import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Plus, Trash2 } from "lucide-react";
import { useBoard, useMilestones, useUpdateSwimlane, useDeleteSwimlane, useArchiveSwimlane, useRestoreSwimlane, useCreateSwimlane, useSession } from "../../lib/queries";
import { sprintProgress } from "../../lib/progress";
import { formatDueChip } from "../../lib/dates";
import { cn } from "../ui/cn";
import type { Swimlane } from "../../../shared/types";
import { SprintProgress } from "../milestones/SprintProgress";
import { SwimlaneForm } from "../kanban/SwimlaneForm";

type StateFilter = "active" | "archived";

export function SwimlanesPage({ slug }: { slug: string }) {
  const { data: board, isLoading, error, refetch } = useBoard(slug, true);
  const { data: milestones = [] } = useMilestones(slug);
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === "superadmin";

  const createSwimlane = useCreateSwimlane(slug);
  const updateSwimlane = useUpdateSwimlane(slug);
  const deleteSwimlane = useDeleteSwimlane(slug);
  const archiveSwimlane = useArchiveSwimlane(slug);
  const restoreSwimlane = useRestoreSwimlane(slug);

  const [milestoneFilter, setMilestoneFilter] = useState("");
  const [stateFilter, setStateFilter] = useState<StateFilter>("active");
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editing, setEditing] = useState<Swimlane | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Swimlane | null>(null);

  const milestoneById = useMemo(() => new Map(milestones.map((m) => [m.id, m])), [milestones]);
  const activeMilestones = milestones.filter((m) => !m.archivedAt);

  const lanes = (board?.swimlanes ?? [])
    .filter((l) => l.kind === "sprint")
    .toSorted((a, b) => a.position - b.position);

  const filtered = lanes.filter((l) => {
    if (stateFilter === "archived" && !l.archivedAt) return false;
    if (stateFilter === "active" && l.archivedAt) return false;
    if (milestoneFilter === "none") return !l.milestoneId;
    if (milestoneFilter !== "" && l.milestoneId !== milestoneFilter) return false;
    return true;
  });

  const groups: { key: string; label: string; meta: string; lanes: Swimlane[] }[] = useMemo(() => {
    const out: { key: string; label: string; meta: string; lanes: Swimlane[] }[] = [];
    for (const m of activeMilestones) {
      const inGroup = filtered.filter((l) => l.milestoneId === m.id);
      if (inGroup.length === 0) continue;
      const due = m.dueAt ? formatDueChip(m.dueAt) : null;
      out.push({
        key: m.id,
        label: m.name,
        meta: `milestone · ${m.archivedSprintCount}/${m.sprintCount} sprints archived${due ? ` · ${due.text}` : ""}`,
        lanes: inGroup,
      });
    }
    const loose = filtered.filter((l) => !l.milestoneId);
    if (loose.length > 0) {
      out.push({ key: "none", label: "No milestone", meta: "loose sprints — milestone_id NULL", lanes: loose });
    }
    return out;
  }, [activeMilestones, filtered]);

  const backlog = (board?.swimlanes ?? []).find((l) => l.kind === "backlog");

  if (isLoading) {
    return (
      <main className="page-frame">
        <div>
          <div className="skeleton" style={{ width: 160, height: 24 }} />
          <div className="skeleton mt-2" style={{ width: 100, height: 12 }} />
          <div className="tasks-filter mt-3">
            <div className="skeleton" style={{ width: 140, height: 32 }} />
            <div className="skeleton" style={{ width: 100, height: 32 }} />
          </div>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton mt-3" style={{ height: 44 }} />
          ))}
        </div>
      </main>
    );
  }
  if (error) {
    return (
      <main className="page-frame">
        <div className="tasks-error">
          <div className="tasks-error-title">Failed to load swimlanes</div>
          <div className="tasks-error-sub">{(error as Error).message}</div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => refetch()}>
            Retry
          </button>
        </div>
      </main>
    );
  }
  if (!board) return <main className="page-frame"><div className="tasks-error">Project not found</div></main>;

  const archivedLanes = lanes.filter((l) => !!l.archivedAt);

  return (
    <main className="page-frame">
      <div>
        <div className="flex items-center justify-between mb-2">
          <div>
            <h1 className="font-display text-2xl weight-600 color-primary">Swimlanes</h1>
            <div className="font-micro text-2xs color-muted mt-1" style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>
              {board.project.name} · {lanes.filter((l) => !l.archivedAt).length} lanes · {archivedLanes.length} archived
            </div>
          </div>
          {isAdmin && (
            <button type="button" className="btn btn-primary" onClick={() => { setEditing(null); setIsFormOpen(true); }}>
              <Plus size={14} strokeWidth={1.5} />
              New Swimlane
            </button>
          )}
        </div>

        <div className="tasks-filter">
          <select className="tasks-select" value={milestoneFilter} onChange={(e) => setMilestoneFilter(e.target.value)} aria-label="Filter by milestone">
            <option value="">All milestones</option>
            <option value="none">No milestone</option>
            {activeMilestones.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
          <select className="tasks-select" value={stateFilter} onChange={(e) => setStateFilter(e.target.value as StateFilter)} aria-label="State filter">
            <option value="active">Active</option>
            <option value="archived">Archived</option>
          </select>
        </div>

        {filtered.length === 0 && (
          <div className="empty-state" style={{ padding: 24 }}>
            <div className="empty-state-icon">
              <svg viewBox="0 0 24 24" width={24} height={24} fill="none" stroke="currentColor" strokeWidth={1.5}>
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="M3 10h18M8 4v16" />
              </svg>
            </div>
            <div className="empty-state-title">No {stateFilter === "archived" ? "archived" : ""} swimlanes{stateFilter === "active" && filtered.length === 0 && !milestoneFilter ? " yet" : ""}</div>
            <div className="empty-state-desc">
              {stateFilter === "archived" ? "Archived lanes land here — Restore brings them back." : "Sprints hold time-boxed work; Backlog is the permanent system lane."}
            </div>
            {stateFilter === "active" && isAdmin && (
              <button type="button" className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => { setEditing(null); setIsFormOpen(true); }}>
                <Plus size={14} strokeWidth={1.5} />
                New Swimlane
              </button>
            )}
          </div>
        )}

        {groups.map((g) => (
          <div key={g.key} className="sl-group">
            <div className="sl-group-title">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M6 9l6 6 6-6" /></svg>
              {g.label}
              <span className="sl-group-meta">{g.meta}</span>
            </div>
            <div className="sl-grid">
              {g.lanes.map((lane) => (
                <LaneRow
                  key={lane.id}
                  lane={lane}
                  board={board}
                  isAdmin={isAdmin}
                  onEdit={() => { setEditing(lane); setIsFormOpen(true); }}
                  onArchive={() => archiveSwimlane.mutate({ id: lane.id })}
                  onRestore={() => restoreSwimlane.mutate({ id: lane.id })}
                  onDelete={() => setDeleteTarget(lane)}
                />
              ))}
            </div>
          </div>
        ))}

        {stateFilter === "active" && backlog && (
          <div className="sl-group">
            <div className="sl-grid">
              <div className="sl-row system">
                <div className="sl-row-main">
                  <span className="sl-kind-chip backlog">Backlog</span>
                  <span className="sl-row-name">{backlog.name}</span>
                  <span className="dim" style={{ fontSize: 11, fontFamily: "var(--lx-font-micro)", marginLeft: 4, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                    system lane
                  </span>
                </div>
                <span className="sl-row-actions">
                  <span className="ms-actions-left">
                    <Link to="/$slug/tasks" params={{ slug }} search={{ swimlane: backlog.id }} className="sl-link-btn">
                      View tasks
                    </Link>
                  </span>
                  <span className="ms-actions-spacer" />
                  <span className="ms-actions-right">
                    {isAdmin && (
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setEditing(backlog); setIsFormOpen(true); }}>
                        Edit
                      </button>
                    )}
                  </span>
                </span>
              </div>
            </div>
          </div>
        )}

        {stateFilter === "active" && archivedLanes.length > 0 && (
          <div className="tasks-state-block" style={{ marginTop: 24 }}>
            <div className="font-micro text-2xs color-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>
              Archived lanes
            </div>
            <div className="sl-grid">
              {archivedLanes.map((lane) => (
                <LaneRow
                  key={lane.id}
                  lane={lane}
                  board={board}
                  isAdmin={isAdmin}
                  onEdit={() => { setEditing(lane); setIsFormOpen(true); }}
                  onArchive={() => archiveSwimlane.mutate({ id: lane.id })}
                  onRestore={() => restoreSwimlane.mutate({ id: lane.id })}
                  onDelete={() => setDeleteTarget(lane)}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {isFormOpen && (
        <SwimlaneForm
          slug={slug}
          swimlane={editing}
          isOpen={isFormOpen}
          onClose={() => setIsFormOpen(false)}
          onSubmit={(input) => {
            if (editing) {
              updateSwimlane.mutate({ id: editing.id, ...input, description: input.description ?? undefined });
            } else {
              createSwimlane.mutate({ ...input, description: input.description ?? undefined });
            }
          }}
        />
      )}

      {deleteTarget && (
        <>
          <button type="button" className="dialog-overlay" onClick={() => setDeleteTarget(null)} aria-label="Close" />
          <div className="fixed inset-0 flex items-center justify-center z-[80] pointer-events-none">
            <dialog open className="dialog dialog-enter pointer-events-auto" aria-modal="true" aria-label="Confirm">
              <h2 className="font-display text-lg font-medium text-lx-text-primary">Delete &lsquo;{deleteTarget.name}&rsquo;?</h2>
              <p className="text-sm text-lx-text-secondary mt-3 leading-5">
                This will unassign all tasks in this swimlane. This action cannot be undone.
              </p>
              <div className="flex items-center gap-2 mt-4 justify-end">
                <button type="button" className="btn btn-ghost" onClick={() => setDeleteTarget(null)}>Cancel</button>
                <button
                  type="button"
                  className="btn btn-danger-solid"
                  onClick={() => {
                    deleteSwimlane.mutate({ id: deleteTarget.id });
                    setDeleteTarget(null);
                  }}
                >
                  <Trash2 size={14} strokeWidth={1.5} />
                  Delete
                </button>
              </div>
            </dialog>
          </div>
        </>
      )}
    </main>
  );
}

function LaneRow({ lane, board, isAdmin, onEdit, onArchive, onRestore, onDelete }: {
  lane: Swimlane;
  board: NonNullable<ReturnType<typeof useBoard>["data"]>;
  isAdmin: boolean;
  onEdit: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const p = sprintProgress(board, lane.id);
  const dateLabel = lane.startAt && lane.dueAt
    ? `${shortDate(lane.startAt)} → ${shortDate(lane.dueAt)}`
    : lane.startAt
      ? `${shortDate(lane.startAt)} → (open)`
      : lane.dueAt
        ? `end ${shortDate(lane.dueAt)}`
        : null;

  return (
    <div className={cn("sl-row", !!lane.archivedAt && "archived")}>
      <div className="sl-row-main">
        <span className="sl-kind-chip">Sprint</span>
        <span className="sl-row-name">{lane.name}</span>
        {dateLabel ? (
          <span className="sl-dates">{dateLabel}</span>
        ) : (
          <span className="sl-dates" style={{ color: "var(--lx-text-muted)" }}>no dates set</span>
        )}
        {!lane.archivedAt && p.total > 0 && <SprintProgress done={p.done} total={p.total} />}
      </div>
      {lane.description && <div className="sl-row-desc">{lane.description}</div>}
      <span className="sl-row-actions">
        <span className="ms-actions-left">
          <Link to="/$slug/tasks" params={{ slug: board.project.slug }} search={{ swimlane: lane.id }} className="sl-link-btn">
            View tasks
          </Link>
        </span>
        <span className="ms-actions-spacer" />
        <span className="ms-actions-right">
          {isAdmin && !lane.archivedAt && (
            <>
              <button type="button" className="btn btn-ghost btn-sm" onClick={onEdit}>Edit</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={onArchive}>Archive</button>
            </>
          )}
          {isAdmin && lane.archivedAt && (
            <>
              <button type="button" className="btn btn-ghost btn-sm" onClick={onRestore}>Restore</button>
              <button type="button" className="btn btn-ghost btn-sm" style={{ color: "var(--lx-text-danger)" }} onClick={onDelete}>Delete</button>
            </>
          )}
        </span>
      </span>
    </div>
  );
}

function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  // @ts-expect-error — strict: exactOptional indexedAccess
  return new Date(Date.UTC(y, m - 1!, d)).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}