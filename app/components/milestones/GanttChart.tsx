import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { addDays, axisDays, buildRange, clampDate, dayForX, formatDay, parseDay, xForDay, DAY_WIDTH_PX } from "../../lib/gantt";
import { cn } from "../ui/cn";
import type { Milestone, Swimlane } from "../../../shared/types";

const LABEL_W = 264;

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
  // Measure the container width so the day grid can extend to fill it (no
  // empty dark space on the right). The grid ends flush at the container's
  // right edge — no trailing bleed.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [wrapWidth, setWrapWidth] = useState(0);
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setWrapWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const minDays = wrapWidth > 0 ? Math.max(0, Math.ceil((wrapWidth - LABEL_W) / DAY_WIDTH_PX)) : 0;
  const { from, to } = useMemo(() => buildRange(items, today, { minDays }), [items, today, minDays]);
  const days = useMemo(() => axisDays(from, to), [from, to]);
  const axisStart = from;
  const canvasW = days.length * DAY_WIDTH_PX;
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragRef | null>(null);
  const justDragged = useRef(false);
  const [dragMode, setDragMode] = useState<DragMode | null>(null);
  const [lanePreview, setLanePreview] = useState<{ id: string; startAt: string | null; dueAt: string | null } | null>(null);
  const [milestonePreview, setMilestonePreview] = useState<{ id: string; dueAt: string } | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set());

  const toggleGroup = (id: string) =>
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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

  // Sprint rows in render order (bars fill their full cell height).
  const sprintPlan = useMemo(() => {
    const plan: TimelineLane[] = [];
    const add = (t: TimelineLane) => plan.push(t);
    for (const m of milestones) {
      if (m.archivedAt || collapsedGroups.has(m.id)) continue;
      for (const l of lanes) {
        if (l.lane.milestoneId === m.id && !l.lane.archivedAt && (l.lane.startAt || l.lane.dueAt)) add(l);
      }
    }
    if (!collapsedGroups.has("__loose__")) for (const l of looseLanes) add(l);
    return plan;
  }, [lanes, milestones, collapsedGroups]);

  if (!hasCanvasItems) return null;

  const gridCols = `${LABEL_W}px repeat(${days.length}, ${DAY_WIDTH_PX}px)`;
  const groupProps = {
    gridTemplateColumns: gridCols,
  };

  // Three-level day axis header: group consecutive days into month spans and
  // consecutive months into year spans.
  const headerSpans = useMemo(() => {
    const months: { label: string; days: number }[] = [];
    const years: { label: string; days: number }[] = [];
    let curMonth = "";
    let curYear = "";
    let monthDays = 0;
    let yearDays = 0;
    for (const d of days) {
      const month = d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
      const year = d.getUTCFullYear().toString();
      if (month !== curMonth) {
        if (curMonth) months.push({ label: curMonth, days: monthDays });
        curMonth = month;
        monthDays = 0;
      }
      if (year !== curYear) {
        if (curYear) years.push({ label: curYear, days: yearDays });
        curYear = year;
        yearDays = 0;
      }
      monthDays++;
      yearDays++;
    }
    months.push({ label: curMonth, days: monthDays });
    years.push({ label: curYear, days: yearDays });
    return { months, years };
  }, [days]);

  let planIdx = 0;
  let zebra = 0;
  const sprintRow = (t: TimelineLane) => {
    const p = sprintPlan[planIdx++]!;
    const bar = barFor(t.lane.id);
    const striped = (zebra++ % 2) === 1;
    return (
      <SprintRow
        key={t.lane.id}
        t={t}
        axisStart={axisStart}
        to={to}
        today={todayDate}
        bar={bar}
        striped={striped}
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
    <div className="timeline-wrap" ref={wrapRef}>
      <div className="timeline">
        {todayClamped && (
          <>
            <div className="tl-today" style={{ left: todayX + LABEL_W }} />
            <span className="tl-today-label" style={{ left: todayX + LABEL_W + 6, top: 4 }}>Today</span>
          </>
        )}
        <div className="tl-grid" style={{ gridTemplateColumns: gridCols }}>
          <div className="tl-head-cell" style={{ gridRow: "span 3", fontWeight: 600, color: "var(--lx-text-primary)", alignItems: "flex-start" }}>Milestone / Sprint</div>
          {headerSpans.years.map((y) => (
            <div key={y.label} className="tl-head-year" style={{ gridColumn: `span ${y.days}` }}>{y.label}</div>
          ))}
          {headerSpans.months.map((m) => (
            <div key={m.label} className="tl-head-month" style={{ gridColumn: `span ${m.days}` }}>{m.label}</div>
          ))}
          {days.map((d, i) => (
            <div key={i} className="tl-head-day">{d.getUTCDate()}</div>
          ))}
        </div>

        <div ref={canvasRef} className="tl-canvas" style={{ position: "relative" }}>
          {milestones.filter((m) => !m.archivedAt).map((m) => {
            const sprints = lanes.filter((l) => l.lane.milestoneId === m.id && !l.lane.archivedAt && (l.lane.startAt || l.lane.dueAt));
            const due = milestoneDue(m);
            const dueChip = due ? formatDueChip(due) : null;
            const collapsed = collapsedGroups.has(m.id);
            return (
              <div key={m.id}>
                <div className={cn("tl-row", (zebra++ % 2) === 1 && "striped")} style={groupProps}>
                  <button
                    type="button"
                    className={cn("tl-label group tl-group-toggle")}
                    onClick={() => toggleGroup(m.id)}
                    aria-expanded={!collapsed}
                  >
                    <svg className={cn("chevron", collapsed && "collapsed")} viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" /></svg>
                    <span className="tl-label-name">{m.name}</span>
                    <span className="lane-ready" style={{ marginLeft: 6 }}>
                      {m.archivedSprintCount}/{m.sprintCount} sprints archived
                    </span>
                  </button>
                  <div className="tl-lane group">
                    {due && (
                      <span
                        className={cn("tl-marker", dueChip?.overdue && "overdue")}
                        style={{ left: xForDay(parseDay(due), axisStart) + DAY_WIDTH_PX / 2 }}
                        title="Due — drag to reschedule"
                        onPointerDown={(e) => beginDrag(e, m.id, "milestone")}
                        onPointerMove={onPointerMove}
                        onPointerUp={endDrag}
                        onClick={() => { if (!justDragged.current) onShowMilestoneList(); }}
                      >
                        <span className="tl-marker-flag">{dueChip?.overdue ? `Due ${dueChip.text} · Overdue · drag ◆ = move due date` : `${dueChip?.text} · drag ◆ = move due date`}</span>
                      </span>
                    )}
                  </div>
                </div>
                {!collapsed && sprints.map(sprintRow)}
              </div>
            );
          })}

          {looseLanes.length > 0 && (
            <div>
              <div className={cn("tl-row", (zebra++ % 2) === 1 && "striped")} style={groupProps}>
                <button
                  type="button"
                  className={cn("tl-label group tl-group-toggle")}
                  onClick={() => toggleGroup("__loose__")}
                  aria-expanded={!collapsedGroups.has("__loose__")}
                >
                  <svg className={cn("chevron", collapsedGroups.has("__loose__") && "collapsed")} viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" /></svg>
                  Loose sprints
                  <span className="sl-group-meta" style={{ fontFamily: "var(--lx-font-micro)", fontSize: 11, color: "var(--lx-text-muted)", marginLeft: 6 }}>no milestone</span>
                </button>
                <div className="tl-lane group" />
              </div>
              {!collapsedGroups.has("__loose__") && looseLanes.map(sprintRow)}
            </div>
          )}

          {backlogLanes.length > 0 && (
            <div className={cn("tl-row", (zebra++ % 2) === 1 && "striped")} style={{ ...groupProps, borderBottom: "none" }}>
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

function SprintRow({ t, axisStart, to, today, bar, striped, dragging, onPointerDown, onPointerMove, onPointerUp, onOpenBoard, isJustDragged, gridCols }: {
  t: TimelineLane;
  axisStart: Date;
  to: Date;
  today: Date;
  bar: { startAt: string | null; dueAt: string | null };
  striped: boolean;
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
    // +DAY_WIDTH_PX so the bar covers the end day's column (Aug 18→21 spans
    // the 18,19,20,21 columns — not stopping at the left edge of 21).
    const w = Math.max(xForDay(e2, axisStart) - x + DAY_WIDTH_PX, DAY_WIDTH_PX);
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
        <span className="tl-bar-label">{t.lane.name}</span>
        <span className="tl-resize-edge" onPointerDown={(e) => { e.stopPropagation(); onPointerDown(e, "edge"); }} />
      </div>
    );
  } else if (hasStart) {
    const s = clampDate(parseDay(startAt!), axisStart, to);
    const e2 = clampDate(today, axisStart, to);
    const x = xForDay(s, axisStart);
    const w = Math.max(xForDay(e2, axisStart) - x + DAY_WIDTH_PX, DAY_WIDTH_PX);
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
        <span className="tl-bar-label">{t.lane.name}</span>
      </div>
    );
  } else if (hasDue) {
    body = (
      <span
        className="tl-marker"
        style={{ left: xForDay(clampDate(parseDay(dueAt!), axisStart, to), axisStart) + DAY_WIDTH_PX / 2 }}
        title="End only — ◆ marker until start set"
      >
        <span className="tl-marker-flag">Ends {shortDate(dueAt!)} · no start yet — set dates in swimlane settings</span>
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
    <div className={cn("tl-row", striped && "striped")} style={{ gridTemplateColumns: gridCols }}>
      <div className="tl-label sprint">
        {t.lane.name}
        {dateLabel && <span className="sl-dates" style={{ marginLeft: 8, fontFamily: "var(--lx-font-micro)", fontSize: 11, color: "var(--lx-text-secondary)" }}>{dateLabel}</span>}
      </div>
      <div className="tl-lane" style={{ userSelect: dragging ? "none" : undefined }}>
        {body}
      </div>
    </div>
  );
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
