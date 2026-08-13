import { useMemo, useRef, useState } from "react";
import { addDays, axisDays, buildRange, clampDate, dayForX, formatDay, parseDay, weekStart, xForDay, DAY_WIDTH_PX } from "../../lib/gantt";
import { cn } from "../ui/cn";
import type { Milestone, Swimlane } from "../../../shared/types";

const LABEL_W = 220;

export interface TimelineLane {
  lane: Swimlane;
  done: number;
  total: number;
}

interface GanttChartProps {
  lanes: TimelineLane[];
  milestones: Milestone[];
  today: string;
  onRescheduleLane: (id: string, dates: { startAt: string | null; dueAt: string | null }) => void;
  onRescheduleMilestone: (id: string, dueAt: string) => void;
  onOpenBoard: (laneId: string) => void;
  onShowMilestoneList: () => void;
}

type DragMode = "lane-body" | "lane-edge" | "milestone";

interface DragRef {
  mode: DragMode;
  id: string;
  startClientX: number;
  startAt: string | null;
  dueAt: string | null;
  moved: boolean;
}

export function GanttChart({ lanes, milestones, today, onRescheduleLane, onRescheduleMilestone, onOpenBoard, onShowMilestoneList }: GanttChartProps) {
  const todayDate = parseDay(today);
  const items = useMemo(
    () => [
      ...lanes.map((l) => ({ startAt: l.lane.startAt, dueAt: l.lane.dueAt })),
      ...milestones.map((m) => ({ startAt: null as string | null, dueAt: m.dueAt })),
    ],
    [lanes, milestones]
  );
  const { from, to } = useMemo(() => buildRange(items, today), [items, today]);
  const axisStart = weekStart(from);
  const days = useMemo(() => axisDays(from, to), [from, to]);
  const weeks = useMemo(() => {
    const out: { start: Date; end: Date }[] = [];
    for (let i = 0; i < days.length; i += 7) out.push({ start: days[i]!, end: days[i + 6]! });
    return out;
  }, [days]);
  const canvasW = days.length * DAY_WIDTH_PX;
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragRef | null>(null);
  const justDragged = useRef(false);
  const [dragMode, setDragMode] = useState<DragMode | null>(null);
  const [lanePreview, setLanePreview] = useState<{ id: string; startAt: string | null; dueAt: string | null } | null>(null);
  const [milestonePreview, setMilestonePreview] = useState<{ id: string; dueAt: string } | null>(null);

  const todayX = xForDay(todayDate, axisStart);
  const todayClamped = todayX >= 0 && todayX <= canvasW;

  const beginDrag = (e: React.PointerEvent, id: string, mode: DragMode) => {
    e.preventDefault();
    e.stopPropagation();
    const lane = lanes.find((l) => l.lane.id === id);
    dragRef.current = {
      mode,
      id,
      startClientX: e.clientX,
      startAt: lane?.lane.startAt ?? null,
      dueAt: lane?.lane.dueAt ?? null,
      moved: false,
    };
    justDragged.current = false;
    setDragMode(mode);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const beginLaneDrag = (e: React.PointerEvent, id: string, mode: "body" | "edge") => {
    beginDrag(e, id, mode === "body" ? "lane-body" : "lane-edge");
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startClientX;
    if (Math.abs(dx) < 3) return;
    d.moved = true;
    justDragged.current = true;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;

    if (d.mode === "milestone") {
      const due = clampDate(parseDay(dayForX(x, axisStart)), axisStart, to);
      setMilestonePreview({ id: d.id, dueAt: formatDay(due) });
      return;
    }
    if (d.mode === "lane-body") {
      const daysShift = Math.round(dx / DAY_WIDTH_PX);
      const newStart = d.startAt ? formatDay(addDays(parseDay(d.startAt), daysShift)) : null;
      const newDue = d.dueAt ? formatDay(addDays(parseDay(d.dueAt), daysShift)) : null;
      setLanePreview({ id: d.id, startAt: newStart, dueAt: newDue });
      return;
    }
    // lane-edge: resize dueAt only, snapped to day
    let due = parseDay(dayForX(x, axisStart));
    if (d.startAt && due <= parseDay(d.startAt)) due = addDays(parseDay(d.startAt), 1);
    setLanePreview({ id: d.id, startAt: d.startAt, dueAt: formatDay(clampDate(due, axisStart, to)) });
  };

  const endDrag = () => {
    const d = dragRef.current;
    dragRef.current = null;
    setDragMode(null);
    if (!d) return;
    if (!d.moved) return;
    if (d.mode === "milestone") {
      const p = milestonePreview;
      if (p?.id === d.id) onRescheduleMilestone(d.id, p.dueAt);
    } else {
      const p = lanePreview;
      if (p?.id === d.id) onRescheduleLane(d.id, { startAt: p.startAt, dueAt: p.dueAt });
    }
    setLanePreview(null);
    setMilestonePreview(null);
    window.setTimeout(() => { justDragged.current = false; }, 0);
  };

  const barFor = (laneId: string) => {
    if (lanePreview?.id === laneId) return { startAt: lanePreview.startAt, dueAt: lanePreview.dueAt };
    const lane = lanes.find((l) => l.lane.id === laneId);
    return { startAt: lane?.lane.startAt ?? null, dueAt: lane?.lane.dueAt ?? null };
  };

  const milestoneDue = (m: Milestone): string | null => {
    if (milestonePreview?.id === m.id) return milestonePreview.dueAt;
    return m.dueAt;
  };

  const activeMilestones = milestones.filter((m) => !m.archivedAt && m.dueAt);
  const looseLanes = lanes.filter((l) => !l.lane.archivedAt && !l.lane.milestoneId && l.lane.kind === "sprint" && (l.lane.startAt || l.lane.dueAt));
  const backlogLanes = lanes.filter((l) => l.lane.kind === "backlog");
  const hasCanvasItems = lanes.some((l) => !l.lane.archivedAt && (l.lane.startAt || l.lane.dueAt)) || activeMilestones.length > 0;

  if (!hasCanvasItems) return null;

  const weekCol = `${DAY_WIDTH_PX * 7}px`;
  const gridCols = `${LABEL_W}px repeat(${weeks.length}, ${weekCol})`;
  const groupProps = {
    gridTemplateColumns: gridCols,
  };

  const sprintRow = (t: TimelineLane) => {
    const bar = barFor(t.lane.id);
    return (
      <SprintRow
        key={t.lane.id}
        t={t}
        axisStart={axisStart}
        to={to}
        today={todayDate}
        bar={bar}
        dragging={dragMode !== null}
        onPointerDown={(e, mode) => beginLaneDrag(e, t.lane.id, mode)}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onOpenBoard={onOpenBoard}
        isJustDragged={() => justDragged.current}
        gridCols={gridCols}
      />
    );
  };

  return (
    <div className="timeline-wrap">
      <div className="timeline" style={{ minWidth: LABEL_W + canvasW + 1 }}>
        <div className="tl-grid" style={{ gridTemplateColumns: gridCols }}>
          <div className="tl-head-cell" style={{ fontWeight: 600, color: "var(--lx-text-primary)" }}>Milestone / Sprint</div>
          {weeks.map((w, i) => (
            <div key={i} className="tl-week-cell">{formatWeekLabel(w.start)}</div>
          ))}
        </div>

        <div ref={canvasRef} className="tl-canvas" style={{ position: "relative" }}>
          {todayClamped && (
            <>
              <div className="tl-today" style={{ left: todayX }} />
              <span className="tl-today-label" style={{ left: todayX + 6, top: 4 }}>Today</span>
            </>
          )}

          {milestones.filter((m) => !m.archivedAt).map((m) => {
            const sprints = lanes.filter((l) => l.lane.milestoneId === m.id && !l.lane.archivedAt && (l.lane.startAt || l.lane.dueAt));
            const due = milestoneDue(m);
            const dueChip = due ? formatDueChip(due) : null;
            return (
              <div key={m.id}>
                <div className="tl-row" style={groupProps}>
                  <div className="tl-label group">
                    <svg className="chevron" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" /></svg>
                    {m.name}
                    <span className="lane-ready" style={{ marginLeft: 6 }}>
                      {m.archivedSprintCount}/{m.sprintCount} sprints archived
                    </span>
                  </div>
                  <div className="tl-lane group">
                    {due && (
                      <span
                        className={cn("tl-marker", dueChip?.overdue && "overdue")}
                        style={{ left: xForDay(parseDay(due), axisStart) }}
                        title="Due — drag to reschedule"
                        onPointerDown={(e) => beginDrag(e, m.id, "milestone")}
                        onPointerMove={onPointerMove}
                        onPointerUp={endDrag}
                        onClick={() => { if (!justDragged.current) onShowMilestoneList(); }}
                      >
                        ◆<span className="tl-marker-flag">{dueChip?.overdue ? `Due ${dueChip.text} · Overdue · drag ◆ = move due date` : `${dueChip?.text} · drag ◆ = move due date`}</span>
                      </span>
                    )}
                  </div>
                </div>
                {sprints.map(sprintRow)}
              </div>
            );
          })}

          {looseLanes.length > 0 && (
            <div>
              <div className="tl-row" style={groupProps}>
                <div className="tl-label group">
                  <svg className="chevron" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" /></svg>
                  Loose sprints
                  <span className="sl-group-meta" style={{ fontFamily: "var(--lx-font-micro)", fontSize: 11, color: "var(--lx-text-muted)", marginLeft: 6 }}>no milestone</span>
                </div>
                <div className="tl-lane group" />
              </div>
              {looseLanes.map(sprintRow)}
            </div>
          )}

          {backlogLanes.length > 0 && (
            <div className="tl-row" style={{ ...groupProps, borderBottom: "none" }}>
              <div className="tl-label caption">
                Backlog
                <span className="sl-group-meta" style={{ fontFamily: "var(--lx-font-micro)", fontSize: 11, color: "var(--lx-text-muted)", marginLeft: 6 }}>system lane</span>
              </div>
              <div className="tl-lane" style={{ borderBottom: "none" }} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SprintRow({ t, axisStart, to, today, bar, dragging, onPointerDown, onPointerMove, onPointerUp, onOpenBoard, isJustDragged, gridCols }: {
  t: TimelineLane;
  axisStart: Date;
  to: Date;
  today: Date;
  bar: { startAt: string | null; dueAt: string | null };
  dragging: boolean;
  onPointerDown: (e: React.PointerEvent, mode: "body" | "edge") => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
  onOpenBoard: (laneId: string) => void;
  isJustDragged: () => boolean;
  gridCols: string;
}) {
  const { startAt, dueAt } = bar;
  const hasStart = !!startAt;
  const hasDue = !!dueAt;

  const fillPct = t.total > 0 ? Math.round((t.done / t.total) * 100) : 0;

  let body: React.ReactNode = null;
  if (hasStart && hasDue) {
    const s = clampDate(parseDay(startAt!), axisStart, to);
    const e2 = clampDate(parseDay(dueAt!), axisStart, to);
    const x = xForDay(s, axisStart);
    const w = Math.max(xForDay(e2, axisStart) - x, 6);
    const overdue = parseDay(dueAt!) < today;
    body = (
      <div
        className={cn("tl-bar", overdue && "overdue")}
        style={{ left: x, width: w, touchAction: "none" }}
        title={`${t.lane.name} — drag body = shift · right edge = resize end`}
        onPointerDown={(e) => onPointerDown(e, "body")}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onClick={() => { if (!isJustDragged()) onOpenBoard(t.lane.id); }}
      >
        <span className="tl-fill" style={{ width: `${fillPct}%` }} />
        <span className="tl-resize-edge" onPointerDown={(e) => { e.stopPropagation(); onPointerDown(e, "edge"); }} />
      </div>
    );
  } else if (hasStart) {
    const s = clampDate(parseDay(startAt!), axisStart, to);
    const e2 = clampDate(today, axisStart, to);
    const x = xForDay(s, axisStart);
    const w = Math.max(xForDay(e2, axisStart) - x, 6);
    body = (
      <div
        className="tl-bar"
        style={{ left: x, width: w, touchAction: "none", borderRightStyle: "dashed" }}
        title="Start only — bar runs to today (live edge)"
        onPointerDown={(e) => onPointerDown(e, "body")}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onClick={() => { if (!isJustDragged()) onOpenBoard(t.lane.id); }}
      >
        <span className="tl-fill" style={{ width: `${fillPct}%` }} />
      </div>
    );
  } else if (hasDue) {
    body = (
      <span
        className="tl-marker"
        style={{ left: xForDay(clampDate(parseDay(dueAt!), axisStart, to), axisStart) }}
        title="End only — ◆ marker until start set"
      >
        ◆<span className="tl-marker-flag">Ends {shortDate(dueAt!)} · no start yet — set dates in swimlane settings</span>
      </span>
    );
  }

  const dateLabel = hasStart && hasDue
    ? `${shortDate(startAt!)} → ${shortDate(dueAt!)}`
    : hasStart
      ? `${shortDate(startAt!)} → (open)`
      : hasDue
        ? `end ${shortDate(dueAt!)}`
        : "";

  return (
    <div className="tl-row" style={{ gridTemplateColumns: gridCols }}>
      <div className="tl-label sprint">
        {t.lane.name}
        {dateLabel && <span className="sl-dates" style={{ marginLeft: 8, fontFamily: "var(--lx-font-micro)", fontSize: 11, color: "var(--lx-text-muted)" }}>{dateLabel}</span>}
      </div>
      <div className="tl-lane" style={{ userSelect: dragging ? "none" : undefined }}>
        {body}
      </div>
    </div>
  );
}

function formatWeekLabel(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function shortDate(iso: string): string {
  return parseDay(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatDueChip(dueAt: string): { text: string; overdue: boolean } {
  const d = parseDay(dueAt);
  const now = new Date();
  const todayUTC = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((d.getTime() - todayUTC) / 86_400_000);
  if (days < 0) return { text: `Overdue ${-days}d`, overdue: true };
  if (days === 0) return { text: "Due today", overdue: false };
  return { text: `Due ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`, overdue: false };
}
