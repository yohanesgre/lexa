import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Plus, X } from "lucide-react";
import { useMilestones, useCreateMilestone, useUpdateMilestone, useDeleteMilestone, useArchiveMilestone, useRestoreMilestone, useBoard, useSession } from "../../lib/queries";
import { sprintProgress, milestoneTaskProgress } from "../../lib/progress";
import { formatDueChip } from "../../lib/dates";
import { cn } from "../ui/cn";
import type { Milestone, Swimlane } from "../../../shared/types";
import { MilestoneForm } from "./MilestoneForm";
import { MilestoneProgress } from "./MilestoneProgress";
import { SprintProgress } from "./SprintProgress";
import { TimelineTab } from "./TimelineTab";

function splitByArchive(milestones: Milestone[]) {
  return {
    active: milestones.filter((m) => !m.archivedAt),
    archived: milestones.filter((m) => !!m.archivedAt),
  };
}

interface RemainingSprint {
  name: string;
  live: number;
  archived: number;
}

function milestoneRemainingSprints(board: NonNullable<ReturnType<typeof useBoard>["data"]> | undefined, milestoneId: string): RemainingSprint[] {
  if (!board) return [];
  return board.swimlanes
    .filter((l) => l.milestoneId === milestoneId && !l.archivedAt)
    .toSorted((a, b) => a.position - b.position)
    .map((lane) => {
      const tasks = board.tasks.filter((t) => t.swimlaneId === lane.id);
      return {
        name: lane.name,
        live: tasks.filter((t) => !t.archivedAt).length,
        archived: tasks.filter((t) => !!t.archivedAt).length,
      };
    });
}

function listSprintNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

function submitMilestoneForm<TInput extends { description?: string | null | undefined }>(
  editing: Milestone | null,
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

function MilestonesSkeleton() {
  return (
    <main className="page-frame page-frame-narrow">
      <div className="ms-tabs">
        <button type="button" className="ms-tab active">Milestones</button>
        <button type="button" className="ms-tab">Timeline</button>
      </div>
      <div className="milestone-card">
        <div className="skeleton" style={{ width: 160, height: 20 }} />
        <div className="skeleton mt-2" style={{ width: "80%", height: 12 }} />
        <div className="skeleton mt-3" style={{ width: "100%", height: 4 }} />
        <div className="skeleton mt-2" style={{ width: "100%", height: 4 }} />
      </div>
      <div className="milestone-card">
        <div className="skeleton" style={{ width: 120, height: 20 }} />
        <div className="skeleton mt-2" style={{ width: "60%", height: 12 }} />
        <div className="skeleton mt-3" style={{ width: "100%", height: 4 }} />
        <div className="skeleton mt-2" style={{ width: "100%", height: 4 }} />
      </div>
    </main>
  );
}

function MilestonesErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <main className="page-frame page-frame-narrow">
      <div className="tasks-error">
        <div className="tasks-error-title">Failed to load milestones</div>
        <div className="tasks-error-sub">{message}</div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
          Retry
        </button>
      </div>
    </main>
  );
}

function EmptyMilestones({ isAdmin, onNew }: { isAdmin: boolean; onNew: () => void }) {
  return (
    <div className="empty-state" style={{ padding: 24 }}>
      <div className="empty-state-icon">
        <svg viewBox="0 0 24 24" width={24} height={24} fill="none" stroke="currentColor" strokeWidth={1.5}>
          <path d="M12 8v4l3 3" />
          <circle cx="12" cy="12" r="9" />
        </svg>
      </div>
      <div className="empty-state-title">No milestones yet</div>
      <div className="empty-state-desc">Group sprints under a goal milestone — v1.0 launch, beta, or release tracks.</div>
      {isAdmin && (
        <button type="button" className="btn btn-primary" style={{ marginTop: 16 }} onClick={onNew}>
          <Plus size={14} strokeWidth={1.5} />
          New Milestone
        </button>
      )}
    </div>
  );
}

export function MilestonesPage({ slug, tab }: { slug: string; tab: "list" | "timeline" }) {
  const { data: milestones = [], isLoading, error, refetch } = useMilestones(slug);
  const { data: board } = useBoard(slug);
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === "superadmin";

  const createMilestone = useCreateMilestone(slug);
  const updateMilestone = useUpdateMilestone(slug);
  const deleteMilestone = useDeleteMilestone(slug);
  const archiveMilestone = useArchiveMilestone(slug);
  const restoreMilestone = useRestoreMilestone(slug);

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editing, setEditing] = useState<Milestone | null>(null);
  const [archiving, setArchiving] = useState<Milestone | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const { active, archived } = splitByArchive(milestones);
  const archivingSprints = archiving ? milestoneRemainingSprints(board, archiving.id) : [];

  const toggleCollapsed = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (isLoading) {
    return <MilestonesSkeleton />;
  }
  if (error) {
    return <MilestonesErrorState message={(error as Error).message} onRetry={() => refetch()} />;
  }

  return (
    <main className="page-frame page-frame-narrow">
      <div className="flex items-center justify-between mb-2">
        <div>
          <h1 className="font-display text-2xl weight-600 color-primary">Milestones</h1>
          <div className="font-micro text-2xs color-muted mt-1" style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>
            {board?.project.name ?? slug} · {active.length} active · {archived.length} archived
          </div>
        </div>
        <div className="flex items-center gap-3">
          {isAdmin && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => { setEditing(null); setIsFormOpen(true); }}
            >
              <Plus size={14} strokeWidth={1.5} />
              New Milestone
            </button>
          )}
        </div>
      </div>

      <div className="ms-tabs">
        <Link to="/$slug/milestones" params={{ slug }} search={{}} activeProps={{ className: "" }} className={cn("ms-tab", tab === "list" && "active")}>
          Milestones
        </Link>
        <Link to="/$slug/milestones" params={{ slug }} search={{ tab: "timeline" }} activeProps={{ className: "" }} className={cn("ms-tab", tab === "timeline" && "active")}>
          Timeline
        </Link>
      </div>

      {tab === "timeline" ? (
        <TimelineTab slug={slug} board={board ?? undefined} milestones={milestones} />
      ) : (
        <div>
          {milestones.length === 0 && (
            <EmptyMilestones isAdmin={isAdmin} onNew={() => { setEditing(null); setIsFormOpen(true); }} />
          )}

          <div className="milestone-grid">
            {active.map((m, i) => (
              <MilestoneCard
                key={m.id}
                milestone={m}
                isActive={i === 0}
                board={board ?? undefined}
                collapsed={collapsed.has(m.id)}
                onToggleCollapsed={() => toggleCollapsed(m.id)}
                isAdmin={isAdmin}
                onEdit={() => { setEditing(m); setIsFormOpen(true); }}
                onArchive={() => setArchiving(m)}
                onDelete={() => deleteMilestone.mutate({ id: m.id })}
              />
            ))}
          </div>

          {archived.length > 0 && (
            <>
              <div className="font-micro text-2xs color-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em", margin: "20px 0 8px" }}>
                Archived milestones
              </div>
              <div className="milestone-grid">
                {archived.map((m) => (
                  <MilestoneCard
                    key={m.id}
                    milestone={m}
                    isActive={false}
                    board={board ?? undefined}
                    collapsed={false}
                    onToggleCollapsed={() => {}}
                    isAdmin={isAdmin}
                    onEdit={() => { setEditing(m); setIsFormOpen(true); }}
                    onArchive={() => {}}
                    onRestore={() => restoreMilestone.mutate({ id: m.id })}
                    onDelete={() => deleteMilestone.mutate({ id: m.id })}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {isFormOpen && (
        <MilestoneForm
          slug={slug}
          milestone={editing}
          isOpen={isFormOpen}
          onClose={() => setIsFormOpen(false)}
          onDelete={editing ? () => { deleteMilestone.mutate({ id: editing.id }); setIsFormOpen(false); } : undefined}
          onSubmit={(input) => submitMilestoneForm(editing, input, updateMilestone, createMilestone)}
        />
      )}

      {archiving && (
        <CompleteMilestoneDialog
          milestone={archiving}
          remainingCount={archiving.sprintCount - archiving.archivedSprintCount}
          sprints={archivingSprints}
          onCancel={() => setArchiving(null)}
          onConfirm={() => {
            archiveMilestone.mutate({ id: archiving.id });
            setArchiving(null);
          }}
        />
      )}
    </main>
  );
}

function milestoneCardClass(isCurrent: boolean, archived: boolean) {
  return cn("milestone-card", isCurrent && "active-callout", archived && "archived");
}

function milestoneCardData(board: ReturnType<typeof useBoard>["data"], milestone: Milestone) {
  const lanes = (board?.swimlanes ?? []).filter((l) => l.milestoneId === milestone.id);
  const tasks = board ? milestoneTaskProgress(board, milestone.id) : { done: 0, total: 0 };
  return { lanes, tasks };
}

function sortMilestoneLanes(lanes: Swimlane[]) {
  return lanes.toSorted((a, b) => a.position - b.position);
}

function milestoneSprintRowClass(lane: Swimlane) {
  return cn("milestone-sprint-row", !!lane.archivedAt && "archived");
}

function sprintDatesCell(lane: Swimlane) {
  if (lane.archivedAt) return laneDatesText(lane) ? `${laneDatesText(lane)} · archived` : "archived";
  return laneDatesText(lane) ?? "";
}

function MilestoneSprints({ board, lanes, collapsed }: {
  board: ReturnType<typeof useBoard>["data"];
  lanes: Swimlane[];
  collapsed: boolean;
}) {
  return (
    <div className="milestone-sprints">
      {sortMilestoneLanes(lanes).map((lane) => {
        const p = board ? sprintProgress(board, lane.id) : { done: 0, total: 0 };
        return (
          <div key={lane.id} className={milestoneSprintRowClass(lane)}>
            <span className="milestone-sprint-name">{lane.name}</span>
            <span className="sl-dates">
              {sprintDatesCell(lane)}
            </span>
            {!lane.archivedAt && p.total > 0 && <SprintProgress done={p.done} total={p.total} />}
            <span className="flex-1" />
            <Link to="/$slug/board" params={{ slug: board?.project.slug ?? "" }} search={{}} className="sl-link-btn">
              View on board
            </Link>
          </div>
        );
      })}
    </div>
  );
}

function ActiveMilestoneActions({ canDelete, onArchive, onEdit, onDelete }: {
  canDelete: boolean;
  onArchive: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <>
      <div className="ms-actions-left">
        <button type="button" className="btn btn-primary btn-sm" onClick={onArchive}>
          Complete milestone
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onEdit}>
          Edit
        </button>
      </div>
      <span className="ms-actions-spacer" />
      <div className="ms-actions-right">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onArchive}>
          Archive
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={!canDelete}
          title={canDelete ? undefined : "409 HAS_CHILDREN — loosen or archive sprints first"}
          onClick={onDelete}
        >
          Delete
        </button>
      </div>
    </>
  );
}

function ArchivedMilestoneActions({ onRestore, onDelete }: {
  onRestore: (() => void) | undefined;
  onDelete: () => void;
}) {
  return (
    <>
      <div className="ms-actions-left">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRestore}>
          Restore
        </button>
      </div>
      <span className="ms-actions-spacer" />
      <div className="ms-actions-right">
        <button type="button" className="btn btn-ghost btn-sm" style={{ color: "var(--lx-text-danger)" }} onClick={onDelete}>
          Delete
        </button>
      </div>
    </>
  );
}

function MilestoneCard({ milestone, isActive, board, collapsed, onToggleCollapsed, isAdmin, onEdit, onArchive, onRestore, onDelete }: {
  milestone: Milestone;
  isActive: boolean;
  board: ReturnType<typeof useBoard>["data"];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  isAdmin: boolean;
  onEdit: () => void;
  onArchive: () => void;
  onRestore?: () => void;
  onDelete: () => void;
}) {
  const due = milestone.dueAt ? formatDueChip(milestone.dueAt) : null;
  const { lanes, tasks } = milestoneCardData(board, milestone);
  const archived = !!milestone.archivedAt;
  const isCurrent = isActive && !archived;
  const canDelete = milestone.sprintCount === 0;

  return (
    <div className={milestoneCardClass(isCurrent, archived)}>
      <div className="milestone-head">
        {lanes.length > 0 && (
          <button
            type="button"
            className="chevron-btn"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? `Expand ${milestone.name} sprints` : `Collapse ${milestone.name} sprints`}
            aria-expanded={!collapsed}
          >
            <svg className={cn("chevron", collapsed && "collapsed")} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        <span className="milestone-name">{milestone.name}</span>
        {!archived && <span className="milestone-badge-active">Active</span>}
        {due ? (
          <span className={cn("milestone-due", due.overdue && "milestone-due-overdue")}>{due.text}</span>
        ) : (
          <span className="milestone-due" style={{ borderColor: "var(--lx-border-default)", color: "var(--lx-text-muted)" }}>no due date</span>
        )}
        <span className="flex-1" />
      </div>
      {milestone.description && <div className="milestone-desc">{milestone.description}</div>}

      <MilestoneProgress
        sprintsArchived={milestone.archivedSprintCount}
        sprintsTotal={milestone.sprintCount}
        tasksDone={tasks.done}
        tasksTotal={tasks.total}
      />

      {lanes.length > 0 && !collapsed && (
        <MilestoneSprints board={board} lanes={lanes} collapsed={collapsed} />
      )}

      {isAdmin && (
        <div className="milestone-card-actions" style={{ marginTop: 14, borderTop: "1px dashed var(--lx-border-default)", paddingTop: 12 }}>
          {!archived ? (
            <ActiveMilestoneActions canDelete={canDelete} onArchive={onArchive} onEdit={onEdit} onDelete={onDelete} />
          ) : (
            <ArchivedMilestoneActions onRestore={onRestore} onDelete={onDelete} />
          )}
        </div>
      )}
    </div>
  );
}

function laneDatesText(lane: Swimlane): string | null {
  const short = (s: string) => s.slice(5).replace("-", "/");
  if (lane.startAt && lane.dueAt) return `${short(lane.startAt)} → ${short(lane.dueAt)}`;
  if (lane.startAt) return `${short(lane.startAt)} → (open)`;
  if (lane.dueAt) return `end ${short(lane.dueAt)}`;
  return null;
}

function CompleteMilestoneDialog({ milestone, remainingCount, sprints, onCancel, onConfirm }: {
  milestone: Milestone;
  remainingCount: number;
  sprints: RemainingSprint[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const liveTaskCount = sprints.reduce((n, s) => n + s.live, 0);
  const archivedTaskCount = sprints.reduce((n, s) => n + s.archived, 0);
  const split = sprints.map((s) => s.live).join(" + ");
  const archivedNote = archivedTaskCount === 0 ? ", none archived yet" : `, ${archivedTaskCount} already archived`;
  return (
    <>
      <button type="button" className="dialog-overlay" onClick={onCancel} aria-label="Close" />
      <div className="fixed inset-0 flex items-center justify-center z-[80] pointer-events-none">
        <dialog open className="dialog dialog-enter pointer-events-auto" aria-modal="true" aria-label="Confirm" style={{ width: 440, maxWidth: "calc(100vw - 48px)" }}>
          <div className="modal-header">
            <span className="modal-title">Complete &lsquo;{milestone.name}&rsquo;?</span>
            <button type="button" className="btn btn-ghost" style={{ width: 32, height: 32, padding: 0 }} onClick={onCancel} aria-label="Close">
              <X size={16} strokeWidth={1.5} />
            </button>
          </div>
          <div className="modal-body">
            <p className="text-sm color-secondary" style={{ lineHeight: "20px" }}>
              This archives the milestone and its{" "}
              <b>{remainingCount} remaining {remainingCount === 1 ? "sprint" : "sprints"}</b>
              {sprints.length > 0 && (
                <>
                  {" — "}
                  {listSprintNames(sprints.map((s) => s.name))}
                  {" — plus their "}
                  <b>{liveTaskCount} live {liveTaskCount === 1 ? "task" : "tasks"}</b>
                  {` (${split}${archivedNote})`}
                </>
              )}
              . The milestone is complete when all its sprints are archived.
            </p>
            <div className="notice notice-danger" style={{ marginTop: 12 }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
              <span>Archive is reversible: Restore brings the milestone back, sprints restore individually.</span>
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
            <button type="button" className="btn btn-danger-solid" onClick={onConfirm}>Complete milestone</button>
          </div>
        </dialog>
      </div>
    </>
  );
}
