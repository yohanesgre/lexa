import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useUpdateSwimlane, useUpdateMilestone, useBoard } from "../../lib/queries";
import { sprintProgress } from "../../lib/progress";
import type { Board, Milestone, Swimlane } from "../../../shared/types";
import { GanttChart, type TimelineLane } from "./GanttChart";
import { MilestoneForm } from "./MilestoneForm";
import { SwimlaneForm } from "../kanban/SwimlaneForm";

export function TimelineTab({ slug, board, milestones }: { slug: string; board: Board | undefined; milestones: Milestone[] }) {
  const navigate = useNavigate();
  const { data: boardData } = useBoard(slug);
  const b = board ?? boardData;
  const updateSwimlane = useUpdateSwimlane(slug);
  const updateMilestone = useUpdateMilestone(slug);

  const [editLane, setEditLane] = useState<Swimlane | null>(null);
  const [editMilestone, setEditMilestone] = useState<Milestone | null>(null);

  const lanes: TimelineLane[] = useMemo(() => {
    if (!b) return [];
    return b.swimlanes
      .filter((l) => !l.archivedAt && l.kind === "sprint")
      .map((lane) => {
        const p = sprintProgress(b, lane.id);
        return { lane, done: p.done, total: p.total };
      });
  }, [b]);

  const milestoneById = useMemo(() => new Map(milestones.map((m) => [m.id, m])), [milestones]);

  const hasCanvasItems = b?.swimlanes.some((l) => !l.archivedAt && (l.startAt || l.dueAt)) ||
    milestones.some((m) => !m.archivedAt && m.dueAt);

  const unsetLanes = lanes.filter((l) => !l.lane.startAt && !l.lane.dueAt);
  const unsetMilestones = milestones.filter((m) => !m.archivedAt && !m.dueAt);

  if (!b) return null;
  if (!hasCanvasItems && unsetLanes.length === 0 && unsetMilestones.length === 0) {
    return (
      <div className="empty-state" style={{ padding: 24 }}>
        <div className="empty-state-icon">
          <svg viewBox="0 0 24 24" width={24} height={24} fill="none" stroke="currentColor" strokeWidth={1.5}>
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M3 10h18" />
          </svg>
        </div>
        <div className="empty-state-title">Nothing to schedule yet</div>
        <div className="empty-state-desc">Create a milestone or set sprint dates to see the timeline.</div>
      </div>
    );
  }

  return (
    <>
      <GanttChart
        lanes={lanes}
        milestones={milestones}
        today={new Date().toISOString().slice(0, 10)}
        onRescheduleLane={(id, dates) => updateSwimlane.mutate({ id, ...dates })}
        onRescheduleMilestone={(id, dueAt) => updateMilestone.mutate({ id, dueAt })}
        onOpenBoard={(laneId) => navigate({ to: "/$slug/board", params: { slug }, search: { swimlane: laneId } } as never)}
        onShowMilestoneList={() => navigate({ to: "/$slug/milestones", params: { slug }, search: {} } as never)}
      />

      {(unsetLanes.length > 0 || unsetMilestones.length > 0) && (
        <div className="tl-unset">
          <div className="tl-unset-title">UNSET DATES — nothing silently disappears</div>
          {unsetMilestones.map((m) => (
            <div key={m.id} className="tl-unset-row">
              <span className="milestone-name" style={{ fontSize: 13 }}>{m.name}</span>
              <span className="sl-milestone-tag">milestone</span>
              <span className="flex-1" />
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditMilestone(m)}>Set dates</button>
            </div>
          ))}
          {unsetLanes.map((t) => (
            <div key={t.lane.id} className="tl-unset-row">
              <span className="milestone-name" style={{ fontSize: 13 }}>{t.lane.name}</span>
              <span className="sl-milestone-tag">sprint</span>
              <span className="flex-1" />
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditLane(t.lane)}>Set dates</button>
            </div>
          ))}
        </div>
      )}

      {editLane && (
        <SwimlaneForm
          slug={slug}
          swimlane={editLane}
          isOpen={!!editLane}
          onClose={() => setEditLane(null)}
          onSubmit={(input) => {
            updateSwimlane.mutate({ id: editLane.id, ...input, description: input.description ?? undefined });
            setEditLane(null);
          }}
        />
      )}

      {editMilestone && (
        <MilestoneForm
          slug={slug}
          milestone={editMilestone}
          isOpen={!!editMilestone}
          onClose={() => setEditMilestone(null)}
          onSubmit={(input) => {
            updateMilestone.mutate({ id: editMilestone.id, ...input, description: input.description ?? undefined });
            setEditMilestone(null);
          }}
        />
      )}
    </>
  );
}
