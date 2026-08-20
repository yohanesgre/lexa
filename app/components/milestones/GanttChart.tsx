import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { addDays, axisDays, buildRange, clampDate, dayForX, formatDay, parseDay, xForDay, DAY_WIDTH_PX } from "../../lib/gantt";
import { cn } from "../ui/cn";
import type { Milestone, Swimlane } from "../../../shared/types";

const LABEL_W = 264;

// Canvas-relative row count at each sprint's row — mirrors the render order
// (milestone groups + their sprints, loose group, backlog).
function computeRowBottoms(
  milestones: Milestone[],
  lanes: TimelineLane[],
  looseLanes: TimelineLane[],
  backlogLanes: TimelineLane[],
  collapsedGroups: ReadonlySet<string>
): { map: Map<string, number>; totalRows: number } {
  const map = new Map<string, number>();
  let rows = 0;
  const bump = () => { rows++; };
  for (const m of milestones) {
    if (m.archivedAt || collapsedGroups.has(m.id)) continue;
    bump(); // group row
    for (const l of lanes) {
      if (l.lane.milestoneId === m.id && !l.lane.archivedAt && (l.lane.startAt || l.lane.dueAt)) {
        bump();
        map.set(l.lane.id, rows);
      }
    }
  }
  if (looseLanes.length > 0 && !collapsedGroups.has("__loose__")) {
    bump(); // loose group row
    for (const l of looseLanes) {
      bump();
      map.set(l.lane.id, rows);
    }
  }
  if (backlogLanes.length > 0) bump(); // backlog row
  return { map, totalRows: rows };
}

function computeGuidelineXs(
  sprintPlan: TimelineLane[],
  rowBottoms: { map: Map<string, number>; totalRows: number },
  barFor: (laneId: string) => { startAt: string | null; dueAt: string | null },
  axisStart: Date,
  to: Date,
  rowH: number
): { left: number; bottom: number }[] {
  const xs: { left: number; bottom: number }[] = [];
  for (const t of sprintPlan) {
    const { startAt, dueAt } = barFor(t.lane.id);
    if (!startAt || !dueAt) continue;
    const rowIdx = rowBottoms.map.get(t.lane.id);
    if (rowIdx === undefined) continue;
    const bottom = rowH * (rowBottoms.totalRows - rowIdx);
    const s = clampDate(parseDay(startAt), axisStart, to);
    const e2 = clampDate(parseDay(dueAt), axisStart, to);
    const x = xForDay(s, axisStart);
    const w = Math.max(xForDay(e2, axisStart) - x + DAY_WIDTH_PX, DAY_WIDTH_PX);
    xs.push({ left: x, bottom }, { left: x + w, bottom });
  }
  return xs;
}

// Three-level day axis header: group consecutive days into month spans and
// consecutive months into year spans.
function computeHeaderSpans(days: Date[]): { months: { label: string; days: number }[]; years: { label: string; days: number }[] } {
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
}

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
  const [scrollLeft, setScrollLeft] = useState(0);
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setWrapWidth(el.clientWidth);
    const onScroll = () => setScrollLeft(el.scrollLeft);
    update();
    onScroll();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", onScroll);
    };
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

  // "Today" shortcut: scroll the wrap horizontally so the TODAY line centers
  // in view. Hidden while today is already fully visible.
  const scrollToToday = () => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const x = todayX + LABEL_W;
    wrap.scrollTo({ left: x - wrap.clientWidth / 2, behavior: "smooth" });
  };
  const todayVisible =
    !todayClamped ||
    (wrapWidth > 0 && todayX + LABEL_W >= scrollLeft && todayX + LABEL_W <= scrollLeft + wrapWidth);

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
  }, [lanes, milestones, collapsedGroups, looseLanes, activeMilestones]);

  // Sprint range guidelines — canvas-level (like the TODAY line): one dashed
  // vertical per start/end edge. Preview-aware so they follow a drag.
  const ROW_H = 56; // .tl-lane height (border-box) — matches .tl-row
  const rowBottoms = computeRowBottoms(milestones, lanes, looseLanes, backlogLanes, collapsedGroups);
  const guidelineXs = computeGuidelineXs(sprintPlan, rowBottoms, barFor, axisStart, to, ROW_H);

  const gridCols = `${LABEL_W}px repeat(${days.length}, ${DAY_WIDTH_PX}px)`;
  const groupProps = {
    gridTemplateColumns: gridCols,
  };

  // Three-level day axis header: group consecutive days into month spans and
  // consecutive months into year spans.
  const headerSpans = useMemo(() => computeHeaderSpans(days), [days]);

  if (!hasCanvasItems) return null;

  return (
    <div className="timeline-wrap" ref={wrapRef}>
      {!todayVisible && (
        <button type="button" className="tl-today-btn" onClick={scrollToToday}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M12 8v4l3 3" /></svg>
          Today
        </button>
      )}
      <div className="timeline">
        {todayClamped && (
          <>
            <div className="tl-today" style={{ left: todayX + LABEL_W }} />
            <span className="tl-today-label" style={{ left: todayX + LABEL_W + 6, top: 4 }}>Today</span>
          </>
        )}
        <TimelineHeader days={days} headerSpans={headerSpans} gridCols={gridCols} />

        <TimelineCanvas
          canvasRef={canvasRef}
          guidelineXs={guidelineXs}
          milestones={milestones}
          lanes={lanes}
          looseLanes={looseLanes}
          backlogLanes={backlogLanes}
          collapsedGroups={collapsedGroups}
          gridCols={gridCols}
          groupProps={groupProps}
          axisStart={axisStart}
          to={to}
          today={todayDate}
          sprintPlan={sprintPlan}
          barFor={barFor}
          milestoneDue={milestoneDue}
          onToggle={toggleGroup}
          onMarkerPointerDown={(e, id) => beginDrag(e, id, "milestone")}
          onMarkerPointerMove={onPointerMove}
          onMarkerPointerUp={endDrag}
          onMarkerClick={onShowMilestoneList}
          isJustDragged={() => justDragged.current}
          onSprintPointerDown={(e, id, mode) => beginLaneDrag(e, id, mode)}
          sprintRowProps={{ dragMode, onPointerMove, onPointerUp: endDrag, onOpenBoard }}
        />
      </div>
    </div>
  );
}

function TimelineCanvas({ canvasRef, guidelineXs, milestones, lanes, looseLanes, backlogLanes, collapsedGroups, gridCols, groupProps, axisStart, to, today, sprintPlan, barFor, milestoneDue, onToggle, onMarkerPointerDown, onMarkerPointerMove, onMarkerPointerUp, onMarkerClick, isJustDragged, onSprintPointerDown, sprintRowProps }: {
  canvasRef: React.RefObject<HTMLDivElement | null>;
  guidelineXs: { left: number; bottom: number }[];
  milestones: Milestone[];
  lanes: TimelineLane[];
  looseLanes: TimelineLane[];
  backlogLanes: TimelineLane[];
  collapsedGroups: ReadonlySet<string>;
  gridCols: string;
  groupProps: { gridTemplateColumns: string };
  axisStart: Date;
  to: Date;
  today: Date;
  sprintPlan: TimelineLane[];
  barFor: (laneId: string) => { startAt: string | null; dueAt: string | null };
  milestoneDue: (m: Milestone) => string | null;
  onToggle: (id: string) => void;
  onMarkerPointerDown: (e: React.PointerEvent, id: string) => void;
  onMarkerPointerMove: (e: React.PointerEvent) => void;
  onMarkerPointerUp: () => void;
  onMarkerClick: () => void;
  isJustDragged: () => boolean;
  onSprintPointerDown: (e: React.PointerEvent, id: string, mode: "body" | "edge") => void;
  sprintRowProps: {
    dragMode: DragMode | null;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: () => void;
    onOpenBoard: (laneId: string) => void;
  };
}) {
  let planIdx = 0;
  let zebra = 0;
  const sprintRow = (t: TimelineLane) => {
    const p = sprintPlan[planIdx++]!;
    void p;
    const bar = barFor(t.lane.id);
    const striped = (zebra++ % 2) === 1;
    return (
      <SprintRow
        key={t.lane.id}
        t={t}
        axisStart={axisStart}
        to={to}
        today={today}
        bar={bar}
        striped={striped}
        dragging={sprintRowProps.dragMode !== null}
        onPointerDown={(e, mode) => onSprintPointerDown(e, t.lane.id, mode)}
        onPointerMove={sprintRowProps.onPointerMove}
        onPointerUp={sprintRowProps.onPointerUp}
        onOpenBoard={sprintRowProps.onOpenBoard}
        isJustDragged={isJustDragged}
        gridCols={gridCols}
      />
    );
  };

  return (
    <div ref={canvasRef} className="tl-canvas" style={{ position: "relative" }}>
      {guidelineXs.map((g, i) => (
        <span key={i} className="tl-guideline" style={{ left: g.left + LABEL_W, top: -22, bottom: g.bottom }} aria-hidden="true" />
      ))}
      {milestones.map((m) => {
        if (m.archivedAt) return null;
        const sprints = lanes.filter((l) => l.lane.milestoneId === m.id && !l.lane.archivedAt && (l.lane.startAt || l.lane.dueAt));
        const due = milestoneDue(m);
        const collapsed = collapsedGroups.has(m.id);
        return (
          <MilestoneGroupRow
            key={m.id}
            m={m}
            sprints={sprints}
            due={due}
            axisStart={axisStart}
            collapsed={collapsed}
            striped={(zebra++ % 2) === 1}
            gridCols={gridCols}
            onToggle={() => onToggle(m.id)}
            onMarkerPointerDown={(e) => onMarkerPointerDown(e, m.id)}
            onMarkerPointerMove={onMarkerPointerMove}
            onMarkerPointerUp={onMarkerPointerUp}
            onMarkerClick={onMarkerClick}
            renderSprint={sprintRow}
          />
        );
      })}

      {looseLanes.length > 0 && (
        <LooseGroupRow
          looseLanes={looseLanes}
          collapsed={collapsedGroups.has("__loose__")}
          onToggle={() => onToggle("__loose__")}
          striped={(zebra++ % 2) === 1}
          groupProps={groupProps}
          renderSprint={sprintRow}
        />
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
  );
}

function LooseGroupRow({ looseLanes, collapsed, onToggle, striped, groupProps, renderSprint }: {
  looseLanes: TimelineLane[];
  collapsed: boolean;
  onToggle: () => void;
  striped: boolean;
  groupProps: { gridTemplateColumns: string };
  renderSprint: (t: TimelineLane) => React.ReactNode;
}) {
  return (
    <div>
      <div className={cn("tl-row", striped && "striped")} style={groupProps}>
        <button
          type="button"
          className={cn("tl-label group tl-group-toggle")}
          onClick={onToggle}
          aria-expanded={!collapsed}
        >
          <svg className={cn("chevron", collapsed && "collapsed")} viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" /></svg>
          Loose sprints
          <span className="sl-group-meta" style={{ fontFamily: "var(--lx-font-micro)", fontSize: 11, color: "var(--lx-text-muted)", marginLeft: 6 }}>no milestone</span>
        </button>
        <div className="tl-lane group" />
      </div>
      {!collapsed && looseLanes.map(renderSprint)}
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
      <button
        type="button"
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
      </button>
    );
  } else if (hasStart) {
    const s = clampDate(parseDay(startAt!), axisStart, to);
    const e2 = clampDate(today, axisStart, to);
    const x = xForDay(s, axisStart);
    const w = Math.max(xForDay(e2, axisStart) - x + DAY_WIDTH_PX, DAY_WIDTH_PX);
    body = (
      <button
        type="button"
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
      </button>
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

function TimelineHeader({ days, headerSpans, gridCols }: {
  days: Date[];
  headerSpans: { months: { label: string; days: number }[]; years: { label: string; days: number }[] };
  gridCols: string;
}) {
  return (
    <div className="tl-grid" style={{ gridTemplateColumns: gridCols }}>
      <div className="tl-head-cell" style={{ gridRow: "span 3", fontWeight: 600, color: "var(--lx-text-primary)", alignItems: "flex-center" }}>Milestone / Sprint</div>
      {headerSpans.years.map((y) => (
        <div key={y.label} className="tl-head-year" style={{ gridColumn: `span ${y.days}` }}>{y.label}</div>
      ))}
      {headerSpans.months.map((m) => (
        <div key={m.label} className="tl-head-month" style={{ gridColumn: `span ${m.days}` }}>{m.label}</div>
      ))}
      {days.map((d) => (
        <div key={d.toISOString()} className="tl-head-day">{d.getUTCDate()}</div>
      ))}
    </div>
  );
}

function MilestoneGroupRow({ m, sprints, due, axisStart, collapsed, striped, gridCols, onToggle, onMarkerPointerDown, onMarkerPointerMove, onMarkerPointerUp, onMarkerClick, renderSprint }: {
  m: Milestone;
  sprints: TimelineLane[];
  due: string | null;
  axisStart: Date;
  collapsed: boolean;
  striped: boolean;
  gridCols: string;
  onToggle: () => void;
  onMarkerPointerDown: (e: React.PointerEvent) => void;
  onMarkerPointerMove: (e: React.PointerEvent) => void;
  onMarkerPointerUp: () => void;
  onMarkerClick: () => void;
  renderSprint: (t: TimelineLane) => React.ReactNode;
}) {
  const dueChip = due ? formatDueChip(due) : null;
  return (
    <div>
      <div className={cn("tl-row", striped && "striped")} style={{ gridTemplateColumns: gridCols }}>
        <button
          type="button"
          className={cn("tl-label group tl-group-toggle")}
          onClick={onToggle}
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
            <button
              type="button"
              className={cn("tl-marker", dueChip?.overdue && "overdue")}
              style={{ left: xForDay(parseDay(due), axisStart) + DAY_WIDTH_PX / 2 }}
              title="Due — drag to reschedule"
              onPointerDown={onMarkerPointerDown}
              onPointerMove={onMarkerPointerMove}
              onPointerUp={onMarkerPointerUp}
              onClick={onMarkerClick}
            >
              <span className="tl-marker-flag">{dueChip?.overdue ? `Due ${dueChip.text} · Overdue · drag ◆ = move due date` : `${dueChip?.text} · drag ◆ = move due date`}</span>
            </button>
          )}
        </div>
      </div>
      {!collapsed && sprints.map(renderSprint)}
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
