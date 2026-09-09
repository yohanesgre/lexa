import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useBoard, useMilestones, useUpdateSwimlane, useDeleteSwimlane, useArchiveSwimlane, useRestoreSwimlane, useCreateSwimlane, useSession } from "../../lib/queries";
import { sprintProgress } from "../../lib/progress";
import { formatDueChip } from "../../lib/dates";
import { cn } from "../ui/cn";
import type { Swimlane } from "../../../shared/types";
import { SprintProgress } from "../milestones/SprintProgress";
import { SwimlaneForm } from "../kanban/SwimlaneForm";
import { DeleteSwimlaneDialog } from "./DeleteSwimlaneDialog";

type StateFilter = "active" | "archived";

interface SwimlaneGroup {
  key: string;
  label: string;
  meta: string;
  lanes: Swimlane[];
}

function sprintLanesOf(board: NonNullable<ReturnType<typeof useBoard>["data"]> | undefined) {
  return (board?.swimlanes ?? [])
    .filter((l) => l.kind === "sprint")
    .toSorted((a, b) => a.position - b.position);
}

function filterLanes(lanes: Swimlane[], stateFilter: StateFilter, milestoneFilter: string) {
  return lanes.filter((l) => {
    if (stateFilter === "archived" && !l.archivedAt) return false;
    if (stateFilter === "active" && l.archivedAt) return false;
    if (milestoneFilter === "none") return !l.milestoneId;
    if (milestoneFilter !== "" && l.milestoneId !== milestoneFilter) return false;
    return true;
  });
}

function buildGroups(activeMilestones: SwimlanesPageMilestone[], filtered: Swimlane[]): SwimlaneGroup[] {
  const out: SwimlaneGroup[] = [];
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
}

interface SwimlanesPageMilestone {
  id: string;
  name: string;
  dueAt: string | null;
  archivedAt: string | null;
  sprintCount: number;
  archivedSprintCount: number;
}

function activeMilestonesOf(milestones: SwimlanesPageMilestone[]) {
  return milestones.filter((m) => !m.archivedAt);
}

function backlogOf(board: NonNullable<ReturnType<typeof useBoard>["data"]> | undefined) {
  return (board?.swimlanes ?? []).find((l) => l.kind === "backlog");
}

function activeLaneCount(lanes: Swimlane[]) {
  return lanes.filter((l) => !l.archivedAt).length;
}

function submitSwimlaneForm<TInput extends { description?: string | null | undefined }>(
  editing: Swimlane | null,
  input: TInput,
  update: { mutate: (input: Omit<TInput, "description"> & { id: string; description?: string | undefined }) => void },
  create: { mutate: (input: Omit<TInput, "description"> & { description?: string | undefined }) => void },
) {
  const payload = { ...input, description: input.description ?? undefined } as Omit<TInput, "description"> & { description?: string | undefined };
  if (editing) {
    update.mutate({ ...payload, id: editing.id });
  } else {
    create.mutate(payload);
  }
}

function SwimlanesSkeleton() {
  return (
    <main className="page-frame page-frame-narrow">
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

function SwimlanesErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <main className="page-frame page-frame-narrow">
      <div className="tasks-error">
        <div className="tasks-error-title">Failed to load swimlanes</div>
        <div className="tasks-error-sub">{message}</div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
          Retry
        </button>
      </div>
    </main>
  );
}

function EmptyLanes({ stateFilter, milestoneFilter, isAdmin, onNew }: {
  stateFilter: StateFilter;
  milestoneFilter: string;
  isAdmin: boolean;
  onNew: () => void;
}) {
  return (
    <div className="empty-state" style={{ padding: 24 }}>
      <div className="empty-state-icon">
        <svg viewBox="0 0 24 24" width={24} height={24} fill="none" stroke="currentColor" strokeWidth={1.5}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 10h18M8 4v16" />
        </svg>
      </div>
      <div className="empty-state-title">No {stateFilter === "archived" ? "archived" : ""} swimlanes{stateFilter === "active" && !milestoneFilter ? " yet" : ""}</div>
      <div className="empty-state-desc">
        {stateFilter === "archived" ? "Archived lanes land here — Restore brings them back." : "Sprints hold time-boxed work; Backlog is the permanent system lane."}
      </div>
      {stateFilter === "active" && isAdmin && (
        <button type="button" className="btn btn-primary" style={{ marginTop: 16 }} onClick={onNew}>
          <Plus size={14} strokeWidth={1.5} />
          New Swimlane
        </button>
      )}
    </div>
  );
}

function BacklogRow({ slug, backlog, isAdmin, onEdit }: {
  slug: string;
  backlog: Swimlane;
  isAdmin: boolean;
  onEdit: () => void;
}) {
  return (
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
            <button type="button" className="btn btn-ghost btn-sm" onClick={onEdit}>
              Edit
            </button>
          )}
        </span>
      </span>
    </div>
  );
}

function SprintGroup({ group, board, isAdmin, onEditLane, onArchiveLane, onRestoreLane, onDeleteLane }: {
  group: SwimlaneGroup;
  board: NonNullable<ReturnType<typeof useBoard>["data"]>;
  isAdmin: boolean;
  onEditLane: (lane: Swimlane) => void;
  onArchiveLane: (id: string) => void;
  onRestoreLane: (id: string) => void;
  onDeleteLane: (lane: Swimlane) => void;
}) {
  return (
    <div className="sl-group">
      <div className="sl-group-title">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M6 9l6 6 6-6" /></svg>
        {group.label}
        <span className="sl-group-meta">{group.meta}</span>
      </div>
      <div className="sl-grid">
        {group.lanes.map((lane) => (
          <LaneRow
            key={lane.id}
            lane={lane}
            board={board}
            isAdmin={isAdmin}
            onEdit={() => onEditLane(lane)}
            onArchive={() => onArchiveLane(lane.id)}
            onRestore={() => onRestoreLane(lane.id)}
            onDelete={() => onDeleteLane(lane)}
          />
        ))}
      </div>
    </div>
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
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

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

  const activeMilestones = useMemo(() => activeMilestonesOf(milestones), [milestones]);

  const lanes = sprintLanesOf(board);
  const filtered = filterLanes(lanes, stateFilter, milestoneFilter);
  const groups = useMemo(
    () => buildGroups(activeMilestones, filtered),
    [activeMilestones, filtered],
  );

  const backlog = backlogOf(board);
  const archivedLanes = lanes.filter((l) => !!l.archivedAt);

  if (isLoading) {
    return <SwimlanesSkeleton />;
  }
  if (error) {
    return <SwimlanesErrorState message={(error as Error).message} onRetry={() => refetch()} />;
  }
  if (!board) return <main className="page-frame page-frame-narrow"><div className="tasks-error">Project not found</div></main>;

  return (
    <main className="page-frame page-frame-narrow">
      <div>
        <div className="flex items-center justify-between mb-2">
          <div>
            <h1 className="font-display text-2xl weight-600 color-primary">Swimlanes</h1>
            <div className="font-micro text-2xs color-muted mt-1" style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>
              {board.project.name} · {activeLaneCount(lanes)} lanes · {archivedLanes.length} archived
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
          <EmptyLanes
            stateFilter={stateFilter}
            milestoneFilter={milestoneFilter}
            isAdmin={isAdmin}
            onNew={() => { setEditing(null); setIsFormOpen(true); }}
          />
        )}

        {groups.map((g) => (
          <SprintGroup
            key={g.key}
            group={g}
            board={board}
            isAdmin={isAdmin}
            onEditLane={(lane) => { setEditing(lane); setIsFormOpen(true); }}
            onArchiveLane={(id) => archiveSwimlane.mutate({ id })}
            onRestoreLane={(id) => restoreSwimlane.mutate({ id })}
            onDeleteLane={(lane) => setDeleteTarget(lane)}
          />
        ))}

        {stateFilter === "active" && backlog && (
          <div className="sl-group">
            <div className="sl-grid">
              <BacklogRow slug={slug} backlog={backlog} isAdmin={isAdmin} onEdit={() => { setEditing(backlog); setIsFormOpen(true); }} />
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
          onSubmit={(input) => submitSwimlaneForm(editing, input, updateSwimlane, createSwimlane)}
        />
      )}

      {deleteTarget && (
        <DeleteSwimlaneDialog
          target={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDelete={() => {
            deleteSwimlane.mutate({ id: deleteTarget.id });
            setDeleteTarget(null);
          }}
        />
      )}
    </main>
  );
}
