import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, Gauge, Plus, Settings } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useDashboard, useBoard, useMilestones, useCreateProject } from "../../lib/queries";
import { getDashboard, getBoard, listMilestones } from "../../lib/api";
import { cn } from "../../components/ui/cn";
import { DashboardSkeleton } from "../../components/DashboardSkeleton";
import { ProjectDescription } from "../../components/ProjectDescription";
import { CreateProjectModal } from "../../components/CreateProjectModal";
import { formatDueChip, parseDateOnly } from "../../lib/dates";
import { formatRelative } from "../../lib/relative-time";
import type {
  Board,
  BoardTask,
  Column,
  FieldOption,
  Milestone,
  OutOfSyncTask,
  ProjectHealth,
} from "../../../shared/types";

export const Route = createFileRoute("/$slug/")({
  ssr:false,
  loader: async ({ context, params }) => {
    const { slug } = params;
    await Promise.all([
      context.queryClient.prefetchQuery({
        queryKey: ["dashboard"],
        queryFn: () => getDashboard(),
      }),
      context.queryClient.prefetchQuery({
        queryKey: ["board", slug, false],
        queryFn: () => getBoard(slug, false),
      }),
      context.queryClient.prefetchQuery({
        queryKey: ["milestones", slug],
        queryFn: () => listMilestones(slug).then((r) => r.data),
      }),
    ]);
  },
  component: ProjectDashboard,
});

const DAY = 86_400_000;

// ── Difficulty ribbons: the project's own configured priorities in rank
// order. Highest rank is black, lowest green, the middle band splits red
// above blue. Colour never travels alone: the rank numeral rides the ribbon
// and the priority's own name is in the accessible label.
type RibbonTone = "highest" | "high" | "normal" | "lowest";

function ribbonFor(priorityId: string, priorities: FieldOption[]): { tone: RibbonTone; numeral: number; label: string; total: number } | null {
  const rank = priorities.findIndex((p) => p.id === priorityId);
  const total = priorities.length;
  if (rank < 0 || total === 0) return null;
  const tone: RibbonTone =
    total === 1 || rank === 0
      ? "highest"
      : rank === total - 1
        ? "lowest"
        : rank <= (total - 1) / 2
          ? "high"
          : "normal";
  return { tone, numeral: rank + 1, label: priorities[rank]!.label, total };
}

function Ribbon({ priorities, priorityId }: { priorities: FieldOption[]; priorityId: string }) {
  const ribbon = ribbonFor(priorityId, priorities);
  if (!ribbon) return null;
  return (
    <>
      <span className="tm-ribbon" data-tone={ribbon.tone} aria-hidden="true">
        {ribbon.numeral}
      </span>
      <span className="tm-visually-hidden">
        Priority {ribbon.label}, rank {ribbon.numeral} of {ribbon.total}
      </span>
    </>
  );
}

// ── Column WIP state, mirroring DashboardService's own derivation.
type ColumnState = "ok" | "approaching" | "exceeded" | "empty";

function columnState(count: number, wipLimit: number | null): ColumnState {
  if (count === 0) return "empty";
  if (wipLimit !== null && count > wipLimit) return "exceeded";
  if (wipLimit !== null && count >= wipLimit) return "approaching";
  return "ok";
}

interface ColumnMeter {
  id: string;
  name: string;
  wipLimit: number | null;
  count: number;
  state: ColumnState;
}

function metersFor(columns: Column[], tasks: BoardTask[]): ColumnMeter[] {
  return columns.map((column) => {
    const count = tasks.filter((task) => task.columnId === column.id && !task.archivedAt).length;
    return { id: column.id, name: column.name, wipLimit: column.wipLimit, count, state: columnState(count, column.wipLimit) };
  });
}

// ── Region 4 rows and region 6 rows, both joined off the board.
interface AttentionRow {
  task: BoardTask;
  reasons: string[];
  columnName: string;
}

interface MoveRow {
  id: string;
  key: string;
  title: string;
  columnName: string;
  time: string;
  issue: string | null;
  priorityId: string;
}

function attentionRows(board: Board, urgentIds: string[], stale: OutOfSyncTask[]): AttentionRow[] {
  const columnName = new Map(board.columns.map((c) => [c.id, c.name]));
  const tasks = new Map(board.tasks.map((t) => [t.id, t]));
  const rows = new Map<string, AttentionRow>();
  const rowFor = (task: BoardTask): AttentionRow => {
    const existing = rows.get(task.id);
    if (existing) return existing;
    const created = { task, reasons: [] as string[], columnName: columnName.get(task.columnId) ?? "No column" };
    rows.set(task.id, created);
    return created;
  };
  for (const id of urgentIds) {
    const task = tasks.get(id);
    if (task) rowFor(task).reasons.push("Urgent");
  }
  for (const item of stale) {
    const task = tasks.get(item.id);
    if (task) rowFor(task).reasons.push(`${item.repo}#${item.issueNumber} closed`);
  }
  return [...rows.values()];
}

function movesFor(board: Board, limit: number): MoveRow[] {
  const columnName = new Map(board.columns.map((c) => [c.id, c.name]));
  return [...board.tasks]
    .filter((task) => !task.archivedAt)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    .slice(0, limit)
    .map((task) => ({
      id: task.id,
      key: task.key,
      title: task.title,
      columnName: columnName.get(task.columnId) ?? "No column",
      time: formatRelative(task.updatedAt),
      issue: task.githubs[0] ? `${task.githubs[0].repo}#${task.githubs[0].issueNumber}` : null,
      priorityId: task.priority,
    }));
}

// ── Region 2: the trail report strip. Plain labels over real state.
function TrailReport({
  slug,
  projectId,
  health,
  meters,
  urgentCount,
  outOfSync,
  milestone,
  repos,
  failed,
  loading,
  onRetry,
}: {
  slug: string;
  projectId: string;
  health: ProjectHealth;
  meters: ColumnMeter[];
  urgentCount: number;
  outOfSync: OutOfSyncTask[];
  milestone: Milestone | null;
  repos: string[];
  failed: boolean;
  loading: boolean;
  onRetry: () => void;
}) {
  const approaching = meters.filter((m) => m.state === "approaching").length;
  const exceeded = meters.filter((m) => m.state === "exceeded").length;
  const attention = urgentCount + outOfSync.length;
  const due = milestone?.dueAt ? formatDueChip(milestone.dueAt) : null;
  const syncState = failed ? "failed" : outOfSync.length > 0 ? "degraded" : "synced";
  const reading = <span className="skeleton tm-skel-value" aria-hidden="true" />;
  const readingLabel = <span className="tm-visually-hidden">Reading the map</span>;

  return (
    <section className="tm-report" aria-label="Trail report" aria-busy={loading}>
      <div className="tm-report-item">
        <span className="tm-plate">Trail report</span>
        <span className="tm-report-value">
          {loading ? (
            <>
              {reading}
              {readingLabel}
            </>
          ) : repos.length === 0 ? (
            <span className="tm-sub">No repo linked</span>
          ) : (
            <>
              <span className="tm-stamp" data-state={syncState}>
                {failed ? "not synced" : outOfSync.length > 0 ? "out of sync" : "synced"}
              </span>
              <span className="tm-figure">
                {repos.join(" · ")}
                {outOfSync[0] ? `#${outOfSync[0].issueNumber}` : ""}
              </span>
            </>
          )}
        </span>
      </div>

      <div className="tm-report-item">
        <span className="tm-plate">Column WIP</span>
        <span className="tm-report-value">
          {loading ? (
            reading
          ) : meters.length === 0 ? (
            <span className="tm-sub">No columns yet</span>
          ) : (
            <>
              <strong>{String(approaching).padStart(2, "0")}</strong>
              <span className="tm-sub">approaching</span>
              <strong className={cn(exceeded > 0 && "tm-danger")}>{String(exceeded).padStart(2, "0")}</strong>
              <span className="tm-sub">exceeded</span>
            </>
          )}
        </span>
      </div>

      <div className="tm-report-item">
        <span className="tm-plate">Needs attention</span>
        {loading ? <span className="skeleton tm-skel-value" aria-hidden="true" /> : <span className="tm-report-count">{String(attention).padStart(2, "0")}</span>}
      </div>

      <div className="tm-report-item">
        <span className="tm-plate">Target</span>
        <span className="tm-report-value">
          {loading ? (
            reading
          ) : milestone ? (
            <>
              <strong>{milestone.name}</strong>
              <span className={cn("tm-sub", due?.overdue && "tm-danger")}>{due?.text ?? "no date"}</span>
            </>
          ) : (
            <span className="tm-sub">No active milestone</span>
          )}
        </span>
      </div>

      <div className="tm-report-item">
        <span className="tm-plate">Tasks</span>
        {loading ? <span className="skeleton tm-skel-value" aria-hidden="true" /> : <span className="tm-report-count">{String(health.taskCount).padStart(3, "0")}</span>}
      </div>

      {loading ? null : failed ? (
        <button type="button" className="btn btn-ghost btn-sm tm-report-link" onClick={onRetry}>
          Retry
        </button>
      ) : repos.length === 0 ? (
        <Link to="/settings/project/$projectId" params={{ projectId }} className="btn btn-ghost btn-sm tm-report-link">
          Link repo
        </Link>
      ) : (
        <Link to="/$slug/board" params={{ slug }} className="btn btn-ghost btn-sm tm-report-link">
          Open board
          <ArrowRight size={14} strokeWidth={1.5} aria-hidden="true" />
        </Link>
      )}
    </section>
  );
}

// ── Region 3: the Trail Profile. Milestone targets are the peaks, sprints the
// runs descending to the Done valley, today the "You are here" post. Lengths
// and counts are the board's own; a run without dates gets a minimum length
// rather than a decorative one.
interface Peak {
  id: string;
  name: string;
  dueAt: string | null;
  x: number;
  y: number;
  dateLabel: string;
}

interface Run {
  id: string;
  name: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  tone: "glacier" | "gold" | "plum" | "meadow";
  done: number;
  total: number;
}

interface ProfileGeometry {
  width: number;
  height: number;
  valleyY: number;
  peaks: Peak[];
  runs: Run[];
  todayX: number;
  spanLabel: string;
}

const RUN_TONES: Run["tone"][] = ["glacier", "gold", "plum", "meadow"];

function buildProfile(milestones: Milestone[], board: Board | undefined, plotWidth: number): ProfileGeometry {
  const height = 200;
  const padX = 28;
  const valleyY = height - 40;
  const ridgeTop = 28;
  const basinY = valleyY - 46;
  const minRun = 64;

  const now = Date.now();
  const at = (value: string | null) => (value ? parseDateOnly(value).getTime() : null);
  const lanes = board?.swimlanes ?? [];

  const starts = lanes.map((lane) => at(lane.startAt)).filter((v): v is number => v !== null);
  const ends = [...lanes.map((lane) => at(lane.dueAt)), ...milestones.map((m) => at(m.dueAt))].filter(
    (v): v is number => v !== null
  );

  const t0 = Math.min(now - 14 * DAY, ...(starts.length > 0 ? starts : [now - 14 * DAY]));
  const t1 = Math.max(now + 7 * DAY, ...(ends.length > 0 ? ends : [now + 7 * DAY]));

  // The plot spans the card: the drawing gets the real width when the card is
  // wider than the projection needs, so no region is dead space and the last
  // peak/sprint labels have room.
  const width = Math.max(plotWidth, 200 + milestones.length * 210);
  const xAt = (value: number) => padX + ((value - t0) / (t1 - t0 || 1)) * (width - 2 * padX);

  const ordered = [...milestones].sort((a, b) => {
    const da = at(a.dueAt);
    const db = at(b.dueAt);
    if (da === null && db === null) return a.position - b.position;
    if (da === null) return 1;
    if (db === null) return -1;
    return da - db;
  });

  const peaks: Peak[] = ordered.map((milestone, index) => {
    const dueMs = at(milestone.dueAt);
    const rankY = ordered.length === 1 ? 0 : index / (ordered.length - 1);
    return {
      id: milestone.id,
      name: milestone.name,
      dueAt: milestone.dueAt,
      x: dueMs === null ? padX + (index + 1) * ((width - 2 * padX) / (ordered.length + 1)) : xAt(dueMs),
      y: basinY - rankY * (basinY - ridgeTop),
      dateLabel: milestone.dueAt
        ? parseDateOnly(milestone.dueAt)
            .toLocaleDateString("en-US", { month: "short", day: "numeric" })
            .replace(" ", "\u00A0")
        : "no target date",
    };
  });

  const runs: Run[] = [];
  for (const [peakIndex, peak] of peaks.entries()) {
    const laneList = lanes
      .filter((lane) => lane.kind === "sprint" && lane.milestoneId === peak.id)
      .sort((a, b) => (at(a.startAt) ?? 0) - (at(b.startAt) ?? 0) || a.position - b.position);
    const anchor = at(peak.dueAt) ?? now;
    for (const [index, lane] of laneList.entries()) {
      const startMs = at(lane.startAt) ?? anchor;
      const endMs = at(lane.dueAt) ?? startMs + 14 * DAY;
      const x0 = xAt(startMs);
      runs.push({
        id: lane.id,
        name: lane.name,
        x0,
        x1: Math.max(xAt(endMs), x0 + minRun),
        y0: peak.y + 14 + index * 9,
        y1: valleyY - 12,
        tone: RUN_TONES[(peakIndex + index) % RUN_TONES.length]!,
        done: lane.tasksDone,
        total: lane.tasksTotal,
      });
    }
  }

  // Loose sprints (no milestone) hang from the valley rail itself: they have
  // no peak and the map says so instead of inventing one.
  const loose = lanes.filter((lane) => lane.kind === "sprint" && lane.milestoneId === null);
  for (const [index, lane] of loose.entries()) {
    const startMs = at(lane.startAt) ?? now;
    const endMs = at(lane.dueAt) ?? startMs + 14 * DAY;
    const x0 = xAt(startMs);
    runs.push({
      id: lane.id,
      name: lane.name,
      x0,
      x1: Math.max(xAt(endMs), x0 + minRun),
      y0: valleyY - 46 + index * 9,
      y1: valleyY - 12,
      tone: RUN_TONES[index % RUN_TONES.length]!,
      done: lane.tasksDone,
      total: lane.tasksTotal,
    });
  }

  const label = (value: number) =>
    new Date(value)
      .toLocaleDateString("en-US", { month: "short", day: "numeric" })
      // Non-breaking space: a date never orphans its day onto the next line.
      .replace(" ", "\u00A0");

  return {
    width,
    height,
    valleyY,
    peaks,
    runs,
    todayX: Math.min(width - padX, Math.max(padX, xAt(now))),
    spanLabel: `${label(t0)} · ${label(t1)}`,
  };
}

// ── Route Trace: a task's descent, drawn from its own links.
interface TraceGeometry {
  key: string;
  points: { x: number; y: number }[];
  length: number;
  label: string;
  gates: { key: string; x: number; y: number }[];
  summary: string;
}

function buildTrace(taskId: string, board: Board | undefined, geometry: ProfileGeometry): TraceGeometry | null {
  if (!board) return null;
  const task = board.tasks.find((t) => t.id === taskId);
  if (!task) return null;
  const lane = board.swimlanes.find((l) => l.id === task.swimlaneId);
  const peak = geometry.peaks.find((p) => p.id === lane?.milestoneId) ?? null;
  const run = geometry.runs.find((r) => r.id === lane?.id) ?? null;
  if (!peak && !run) return null;

  const points: { x: number; y: number }[] = [];
  if (peak) points.push({ x: peak.x, y: peak.y });
  if (run) {
    // Descend the lift to the run's own ground, then take the run down.
    points.push({ x: run.x0, y: peak ? peak.y + 10 : run.y0 });
    points.push({ x: run.x0, y: run.y0 });
    points.push({ x: run.x1, y: run.y1 });
  } else if (peak) {
    points.push({ x: peak.x, y: geometry.valleyY - 12 });
  }

  const first = points[0]!;
  const last = points[points.length - 1]!;
  let length = 0;
  for (let i = 1; i < points.length; i += 1) {
    length += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  }
  if (length < 60) length = 60;

  const blockers = board.links
    .filter((link) => link.relation === "blocked_by" && link.fromTaskId === task.id)
    .map((link) => board.tasks.find((t) => t.id === link.toTaskId))
    .filter((t): t is BoardTask => Boolean(t));

  const gates = blockers.map((blocker, index) => {
    const fraction = Math.min(0.55 + index * 0.2, 0.95);
    return {
      key: blocker.key,
      x: first.x + (last.x - first.x) * fraction,
      y: first.y + (last.y - first.y) * fraction,
    };
  });

  return {
    key: task.key,
    points,
    length: Math.ceil(length),
    label: `${task.key} route`,
    gates,
    summary: `${peak ? peak.name : "no milestone"} to ${lane ? lane.name : "no run"} to Done, ${blockers.length} blocked-by`,
  };
}

function TrailProfile({
  slug,
  milestones,
  board,
  loading,
  milestonesFailed,
  onRetry,
  tracedId,
}: {
  slug: string;
  milestones: Milestone[];
  board: Board | undefined;
  loading: boolean;
  milestonesFailed: boolean;
  onRetry: () => void;
  tracedId: string | null;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [plotWidth, setPlotWidth] = useState(0);

  // The panorama takes the card's real width, so the plot never stops short of
  // its frame and the last labels have room inside it.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = () => setPlotWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [loading, milestonesFailed, milestones.length]);

  const geometry = useMemo(() => buildProfile(milestones, board, plotWidth), [milestones, board, plotWidth]);
  const trace = tracedId ? buildTrace(tracedId, board, geometry) : null;
  const todayX = geometry.todayX;

  // Whole-cell repack: the strip opens pinned at today, on desktop and phone.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollLeft = Math.max(0, todayX - el.clientWidth * 0.35);
  }, [todayX, geometry.width]);

  const head = (
    <div className="tm-profile-head">
      <div>
        <h2 className="tm-plate-lg">Trail profile</h2>
        <p className="tm-sub">
          <span className="tm-sub-part">Milestones and sprint progress</span>
          <span className="tm-sub-part tm-sub-range">· {geometry.spanLabel}</span>
        </p>
      </div>
      <span className="tm-profile-note tm-figure">
        {milestones.length} {milestones.length === 1 ? "peak" : "peaks"} · {geometry.runs.length} runs
      </span>
    </div>
  );

  if (loading) {
    return (
      <section className="tm-profile" aria-label="Trail profile" aria-busy="true">
        {head}
        <div className="tm-profile-body" aria-hidden="true">
          {/* Skeleton ridge lines: the map draws before it answers. */}
          <svg width="100%" height="150" viewBox="0 0 880 150" preserveAspectRatio="none" className="tm-profile-skeleton">
            <polyline className="tm-profile-ridge" points="0,120 120,80 240,110 360,60 480,95 600,45 720,85 880,60" />
            <polyline className="tm-profile-ridge" points="0,140 140,120 280,132 420,105 560,124 700,100 880,120" />
            <line className="tm-profile-axis" x1="0" y1="142" x2="880" y2="142" />
          </svg>
          <p className="tm-sub">Reading the map…</p>
        </div>
      </section>
    );
  }

  if (milestonesFailed) {
    return (
      <section className="tm-profile" aria-label="Trail profile">
        {head}
        <div className="tm-profile-body">
          <div className="tm-void" data-tone="error">
            <span className="tm-void-title">The profile did not load</span>
            <span>Milestones could not be read for this project.</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
              Retry
            </button>
          </div>
        </div>
      </section>
    );
  }

  if (milestones.length === 0) {
    return (
      <section className="tm-profile" aria-label="Trail profile">
        {head}
        <div className="tm-profile-body">
          <div className="tm-void">
            <span className="tm-void-title">No peaks on the map yet</span>
            <span>A milestone sets the target; its sprints become the runs down to Done.</span>
            <Link to="/$slug/milestones" params={{ slug }} className="btn btn-primary btn-sm">
              Add milestone
            </Link>
          </div>
        </div>
      </section>
    );
  }

  const valley = geometry.valleyY;
  const tracePath = trace
    ? trace.points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ")
    : "";

  return (
    <section className="tm-profile" aria-label="Trail profile" data-tracing={trace ? "true" : "false"}>
      {head}
      <div className="tm-profile-scroll" ref={scrollerRef}>
        <svg
          width={geometry.width}
          height={geometry.height}
          viewBox={`0 0 ${geometry.width} ${geometry.height}`}
          role="img"
          aria-label={`Trail profile: ${milestones.length} milestone peaks, ${geometry.runs.length} sprint runs, today ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
        >
          <rect className="tm-valley" x={0} y={valley} width={geometry.width} height={geometry.height - valley} />
          <line className="tm-profile-axis" x1={0} y1={valley} x2={geometry.width} y2={valley} />
          <text className="tm-valley-label" x={12} y={valley + 18}>
            Done valley
          </text>

          {/* runs: length is the sprint's real duration, progress is tasks done */}
          {geometry.runs.map((run) => {
            const fraction = run.total > 0 ? Math.min(1, run.done / run.total) : 0;
            const px = run.x0 + (run.x1 - run.x0) * fraction;
            const py = run.y0 + (run.y1 - run.y0) * fraction;
            return (
              <g key={run.id}>
                <line className="tm-run" data-tone={run.tone} x1={run.x0} y1={run.y0} x2={run.x1} y2={run.y1} />
                {fraction > 0 && <line className="tm-run-progress" x1={run.x0} y1={run.y0} x2={px} y2={py} />}
                <circle
                  className={cn("tm-post", run.total > 0 && run.done >= run.total && "tm-post-done")}
                  cx={run.x1}
                  cy={run.y1}
                  r={4}
                />
                <text
                  className="tm-post-label"
                  x={run.x1 > geometry.width - 90 ? run.x1 - 18 : run.x1 - 4}
                  y={run.y1 + 18}
                  textAnchor={run.x1 > geometry.width - 90 ? "end" : "start"}
                >
                  {run.name} · {run.done}/{run.total}
                </text>
              </g>
            );
          })}

          {/* peaks: milestone targets, altitude by target date */}
          {geometry.peaks.map((peak) => {
            const flip = peak.x > geometry.width - 150;
            return (
              <g key={peak.id}>
                <line className="tm-peak-line" x1={peak.x} y1={peak.y} x2={peak.x} y2={valley} />
                <circle className="tm-peak-dot" cx={peak.x} cy={peak.y} r={5} />
                <text
                  className="tm-peak-label"
                  x={peak.x + (flip ? -9 : 9)}
                  y={peak.y - 4}
                  textAnchor={flip ? "end" : "start"}
                >
                  {peak.name}
                </text>
                <text
                  className="tm-peak-date"
                  x={peak.x + (flip ? -9 : 9)}
                  y={peak.y + 10}
                  textAnchor={flip ? "end" : "start"}
                >
                  {peak.dateLabel}
                </text>
              </g>
            );
          })}

          <line className="tm-today" x1={geometry.todayX} y1={20} x2={geometry.todayX} y2={geometry.height - 6} />
          <text className="tm-today-flag" x={geometry.todayX + 6} y={30}>
            You are here
          </text>

          {/* Route Trace: the hovered or focused task's own descent */}
          {trace && (
            <g>
              <path
                className="tm-trace"
                d={tracePath}
                strokeDasharray={trace.length}
                style={{ "--tm-trace-len": String(trace.length) } as CSSProperties}
              />
              <circle className="tm-trace-head" cx={trace.points[0]!.x} cy={trace.points[0]!.y} r={5} />
              {/* The trace label sits on the opposite side of the peak from the
                  milestone's own label, so the two never overlap. */}
              <text
                className="tm-trace-label"
                x={trace.points[0]!.x + (trace.points[0]!.x > geometry.width - 150 ? 9 : -9)}
                y={Math.max(12, trace.points[0]!.y - 22)}
                textAnchor={trace.points[0]!.x > geometry.width - 150 ? "start" : "end"}
              >
                {trace.label}
              </text>
              {trace.gates.map((gate) => (
                <g key={gate.key}>
                  <line className="tm-gate" x1={gate.x - 7} y1={gate.y} x2={gate.x + 7} y2={gate.y} />
                  <text className="tm-gate-label" x={gate.x + 10} y={gate.y + 4}>
                    {gate.key}
                  </text>
                </g>
              ))}
            </g>
          )}
        </svg>
      </div>
      {tracedId && !trace && (
        <div className="tm-profile-body">
          <div className="tm-void">
            <span className="tm-void-title">This task has no route on the map</span>
            <span>It sits in a lane with no sprint, so there is nothing to trace.</span>
          </div>
        </div>
      )}
      <p className="tm-visually-hidden" aria-live="polite">
        {trace ? trace.summary : ""}
      </p>
    </section>
  );
}
// ── Region 4: Needs attention.
function NeedsAttention({
  rows,
  priorities,
  traceId,
  loading,
  onTrace,
  onTraceEnd,
  onOpen,
}: {
  rows: AttentionRow[];
  priorities: FieldOption[];
  traceId: string | null;
  loading: boolean;
  onTrace: (id: string) => void;
  onTraceEnd: () => void;
  onOpen: (id: string) => void;
}) {
  return (
    <section className="tm-section" aria-label="Needs attention" aria-busy={loading}>
      <div className="tm-section-head">
        <div>
          <h2 className="tm-plate-lg">Needs attention</h2>
          <p className="tm-sub">Urgent work and issues GitHub has closed</p>
        </div>
        <span className="tm-chip tm-figure">{loading ? "--" : String(rows.length).padStart(2, "0")}</span>
      </div>
      {loading ? (
        <div className="tm-rows" aria-hidden="true">
          {[0, 1, 2].map((key) => (
            <div key={key} className="skeleton tm-skel-row" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="tm-void">
          <span className="tm-void-title">All clear, nothing needs patrol</span>
          <span>Urgent tasks and stale GitHub links land here.</span>
        </div>
      ) : (
        <div className="tm-rows">
          {rows.map(({ task, reasons, columnName }) => (
            <button
              key={task.id}
              type="button"
              className={cn("tm-row", traceId === task.id && "is-traced")}
              onClick={() => onOpen(task.id)}
              onMouseEnter={() => onTrace(task.id)}
              onMouseLeave={onTraceEnd}
              onFocus={() => onTrace(task.id)}
              onBlur={onTraceEnd}
            >
              <span className="tm-row-ribbon">
                <Ribbon priorities={priorities} priorityId={task.priority} />
              </span>
              <span className="tm-row-body">
                <span className="tm-row-head">
                  <span className="tm-key">{task.key}</span>
                  <span className="tm-row-title">{task.title}</span>
                </span>
                <span className="tm-row-meta">
                  {columnName}
                  {reasons.length > 0 ? ` · ${reasons.join(" · ")}` : ""}
                </span>
              </span>
              <span className="tm-row-owners">
                {task.assignees.length > 0 ? (
                  task.assignees.map((name) => (
                    <span key={name} className="tm-keycap">
                      {name.slice(0, 2).toUpperCase()}
                    </span>
                  ))
                ) : (
                  <span className="tm-keycap">--</span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

// ── Region 5: Column WIP meters. The fill is exact against the limit; past
// the limit the meter pins at full and the count plus the state carry it.
function WipMeters({ slug, meters, loading }: { slug: string; meters: ColumnMeter[]; loading: boolean }) {
  const exceeded = meters.filter((m) => m.state === "exceeded").length;
  return (
    <section className="tm-section" aria-label="Column WIP" aria-busy={loading}>
      <div className="tm-section-head">
        <div>
          <h2 className="tm-plate-lg">Column WIP</h2>
          <p className="tm-sub">
            Counts against each column&apos;s limit{exceeded > 0 ? ` · ${exceeded} exceeded` : ""}
          </p>
        </div>
        <Gauge size={16} strokeWidth={1.5} className="tm-muted-icon" aria-hidden="true" />
      </div>
      {loading ? (
        <div className="tm-meters" aria-hidden="true">
          {[0, 1, 2].map((key) => (
            <div key={key} className="skeleton tm-skel-row" />
          ))}
        </div>
      ) : meters.length === 0 ? (
        <div className="tm-void">
          <span className="tm-void-title">No columns yet</span>
          <span>Open Board setup to lay out the runs.</span>
          <Link to="/$slug/board" params={{ slug }} className="btn btn-ghost btn-sm">
            Open Board setup
          </Link>
        </div>
      ) : (
        <div className="tm-meters">
          {meters.map((meter) => {
            const ratio = meter.wipLimit && meter.wipLimit > 0 ? Math.min(1, meter.count / meter.wipLimit) : 0;
            return (
              <Link
                key={meter.id}
                to="/$slug/board"
                params={{ slug }}
                className="tm-meter"
                data-state={meter.state}
                aria-label={`${meter.name}: ${meter.count} tasks${meter.wipLimit ? ` against a limit of ${meter.wipLimit}` : ", no limit"}`}
              >
                <span className="tm-meter-name">{meter.name}</span>
                <span className="tm-meter-count">
                  {meter.count}
                  {meter.wipLimit ? ` / ${meter.wipLimit}` : ""}
                </span>
                <span className="tm-meter-state">
                  {meter.wipLimit ? meter.state : "no limit"}
                </span>
                {/* The fill is exact against the ruled limit; a column with no
                    limit has nothing to fill, so it stays empty. */}
                <span className="tm-meter-track">
                  {meter.wipLimit ? (
                    <>
                      <span className="tm-meter-fill" style={{ width: `${ratio * 100}%` }} />
                      <span className="tm-meter-limit" />
                    </>
                  ) : null}
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ── Region 6: Recent movement.
function RecentMovement({
  rows,
  priorities,
  traceId,
  loading,
  onTrace,
  onTraceEnd,
  onOpen,
}: {
  rows: MoveRow[];
  priorities: FieldOption[];
  traceId: string | null;
  loading: boolean;
  onTrace: (id: string) => void;
  onTraceEnd: () => void;
  onOpen: (id: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [rowCap, setRowCap] = useState<number | null>(null);

  // The strip caps at three whole rows; the cap is measured from the rendered
  // row so it can never slice one in half.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => {
      const first = el.querySelector<HTMLElement>(".tm-move");
      if (!first) return;
      const rowHeight = first.getBoundingClientRect().height;
      const gap = 2;
      if (rowHeight > 0) setRowCap(Math.round((rowHeight + gap) * 3 - gap));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [rows.length]);

  return (
    <section className="tm-section" aria-label="Recent movement" aria-busy={loading}>
      <div className="tm-section-head">
        <div>
          <h2 className="tm-plate-lg">Recent movement</h2>
          <p className="tm-sub">Newest board changes first · the strip scrolls for more</p>
        </div>
      </div>
      {loading ? (
        <div className="tm-moves" aria-hidden="true">
          {[0, 1, 2].map((key) => (
            <div key={key} className="skeleton tm-skel-row" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="tm-void">
          <span className="tm-void-title">Nothing has moved yet</span>
          <span>Task edits and GitHub stamps show up here.</span>
        </div>
      ) : (
        <div
          className="tm-moves"
          ref={listRef}
          style={rowCap === null ? undefined : ({ "--tm-move-cap": `${rowCap}px` } as CSSProperties)}
        >
          {rows.map((row, index) => (
            <button
              key={row.id}
              type="button"
              className={cn("tm-move", traceId === row.id && "is-traced")}
              data-overflow={index >= 3 ? "true" : "false"}
              onClick={() => onOpen(row.id)}
              onMouseEnter={() => onTrace(row.id)}
              onMouseLeave={onTraceEnd}
              onFocus={() => onTrace(row.id)}
              onBlur={onTraceEnd}
            >
              <span className="tm-move-time">{row.time}</span>
              <span className="tm-move-body">
                <span className="tm-move-line">
                  <Ribbon priorities={priorities} priorityId={row.priorityId} />
                  <span className="tm-key">{row.key}</span>
                  <span>{row.title}</span>
                </span>
                <span className="tm-row-meta">
                  {row.columnName}
                  {row.issue ? ` · ${row.issue}` : ""}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function ProjectDashboard() {
  const navigate = useNavigate();
  const { slug } = Route.useParams();
  const { data: dashboard, isLoading, isError: dashboardFailed, refetch: refetchDashboard } = useDashboard();
  const board = useBoard(slug);
  const { data: milestones = [], isError: milestonesFailed, refetch: refetchMilestones } = useMilestones(slug);
  const createProject = useCreateProject();
  const [showCreate, setShowCreate] = useState(false);
  const [traced, setTraced] = useState<string | null>(null);

  // Escape clears the Route Trace, wherever focus sits.
  useEffect(() => {
    if (!traced) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setTraced(null);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [traced]);

  const liveMilestones = useMemo(() => milestones.filter((m) => !m.archivedAt), [milestones]);
  const priorities = board.data?.fieldConfig.priorities ?? [];
  const meters = useMemo(() => metersFor(board.data?.columns ?? [], board.data?.tasks ?? []), [board.data]);
  const moves = useMemo(() => (board.data ? movesFor(board.data, 6) : []), [board.data]);
  const stale = useMemo(
    () => dashboard?.outOfSyncTasks.filter((t) => t.projectSlug === slug) ?? [],
    [dashboard, slug]
  );
  const urgentIds = useMemo(
    () => dashboard?.urgentTasks.filter((t) => t.projectSlug === slug).map((t) => t.id) ?? [],
    [dashboard, slug]
  );
  const attention = useMemo(
    () => (board.data ? attentionRows(board.data, urgentIds, stale) : []),
    [board.data, urgentIds, stale]
  );

  const health: ProjectHealth = useMemo(() => {
    const fromDashboard = dashboard?.projects.find((entry) => entry.project.slug === slug);
    if (fromDashboard) return fromDashboard;
    // A project without a dashboard entry renders with zeroed stats, never the
    // workspace empty state.
    return {
      project: board.data?.project ?? {
        id: "",
        name: slug,
        slug,
        key: "",
        description: "",
        repos: [],
        createdAt: "",
        updatedAt: "",
      },
      taskCount: 0,
      columnCount: 0,
      urgentCount: 0,
      syncCount: 0,
      health: "ok",
      wipSegments: [],
    };
  }, [dashboard, board.data, slug]);

  const openTask = (id: string) => {
    void navigate({ to: "/$slug/board", params: { slug }, search: { task: id } as never });
  };

  // The board is the slowest read; until it lands every region draws its own
  // loading state instead of the page swapping whole.
  const regionsLoading = board.isLoading && !board.data;

  if (isLoading) {
    return (
      <main className="page-frame page-frame-narrow">
        <DashboardSkeleton />
      </main>
    );
  }

  return (
    <main className="page-frame page-frame-narrow">
      <div className="tm-dash">
        <div className="tm-dash-head">
          <h1>{health.project.name}</h1>
          <span className="tm-plate">Dashboard</span>
          <span className="nav-spacer" />
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-label="Project settings"
            onClick={() => navigate({ to: "/settings/project/$projectId", params: { projectId: health.project.id } })}
          >
            <Settings size={14} strokeWidth={1.5} aria-hidden="true" />
            Project settings
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowCreate(true)}>
            <Plus size={14} strokeWidth={1.5} aria-hidden="true" />
            New Project
          </button>
        </div>

        <TrailReport
          slug={slug}
          projectId={health.project.id}
          health={health}
          meters={meters}
          urgentCount={urgentIds.length}
          outOfSync={stale}
          milestone={liveMilestones.find((m) => m.dueAt) ?? liveMilestones[0] ?? null}
          repos={board.data?.project.repos.map((repo) => repo.repo) ?? []}
          failed={dashboardFailed}
          loading={regionsLoading}
          onRetry={() => void refetchDashboard()}
        />

        {regionsLoading ? (
          <>
            <TrailProfile
              slug={slug}
              milestones={liveMilestones}
              board={board.data}
              loading
              milestonesFailed={false}
              onRetry={() => void refetchMilestones()}
              tracedId={null}
            />
            <div className="tm-dash-grid">
              <NeedsAttention
                rows={[]}
                priorities={priorities}
                traceId={null}
                loading
                onTrace={setTraced}
                onTraceEnd={() => setTraced(null)}
                onOpen={openTask}
              />
              <WipMeters slug={slug} meters={meters} loading />
            </div>
            <RecentMovement
              rows={[]}
              priorities={priorities}
              traceId={null}
              loading
              onTrace={setTraced}
              onTraceEnd={() => setTraced(null)}
              onOpen={openTask}
            />
          </>
        ) : board.isError ? (
          <section className="tm-section" aria-label="Board">
            <div className="tm-void" data-tone="error">
              <span className="tm-void-title">Failed to load board</span>
              <span>{(board.error as Error).message}</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void board.refetch()}>
                Retry
              </button>
            </div>
          </section>
        ) : !board.data ? (
          <section className="tm-section" aria-label="Board">
            <div className="tm-void">
              <span className="tm-void-title">Project not found</span>
              <Link to="/" className="btn btn-ghost btn-sm">
                All projects
              </Link>
            </div>
          </section>
        ) : (
          <>
            <TrailProfile
              slug={slug}
              milestones={liveMilestones}
              board={board.data}
              loading={false}
              milestonesFailed={milestonesFailed}
              onRetry={() => void refetchMilestones()}
              tracedId={traced}
            />

            <div className="tm-dash-grid">
              <NeedsAttention
                rows={attention}
                priorities={priorities}
                traceId={traced}
                loading={false}
                onTrace={setTraced}
                onTraceEnd={() => setTraced(null)}
                onOpen={openTask}
              />
              <WipMeters slug={slug} meters={meters} loading={false} />
            </div>

            <RecentMovement
              rows={moves}
              priorities={priorities}
              traceId={traced}
              loading={false}
              onTrace={setTraced}
              onTraceEnd={() => setTraced(null)}
              onOpen={openTask}
            />

            {/* Kept, but after the six acceptance regions so the contract's
                order reads down the page. */}
            <ProjectDescription description={health.project.description || board.data.project.description || ""} />
          </>
        )}
      </div>

      <CreateProjectModal
        open={showCreate}
        pending={createProject.isPending}
        onClose={() => setShowCreate(false)}
        onSubmit={(input) => {
          createProject.mutate(input, {
            onSuccess: () => setShowCreate(false),
          });
        }}
      />
    </main>
  );
}
