import { cn } from "../ui/cn";

interface MilestoneProgressProps {
  sprintsArchived: number;
  sprintsTotal: number;
  tasksDone: number;
  tasksTotal: number;
}

// Two compact bars: sprints archived X/Y + tasks done X/Y.
export function MilestoneProgress({ sprintsArchived, sprintsTotal, tasksDone, tasksTotal }: MilestoneProgressProps) {
  const sprintPct = sprintsTotal > 0 ? Math.round((sprintsArchived / sprintsTotal) * 100) : 0;
  const taskPct = tasksTotal > 0 ? Math.round((tasksDone / tasksTotal) * 100) : 0;

  const sprintFill = sprintsTotal > 0 ? (sprintsArchived === sprintsTotal ? "ms-bar-fill" : "ms-bar-fill partial") : "ms-bar-fill zero";
  const taskFill = tasksTotal > 0 ? (tasksDone === tasksTotal ? "ms-bar-fill" : "ms-bar-fill partial") : "ms-bar-fill zero";

  return (
    <div className="ms-progress-block">
      <div className="ms-progress-row">
        <span style={{ minWidth: 96 }}>Sprints {sprintsArchived}/{sprintsTotal} archived</span>
        <div className="ms-bar"><span className={cn(sprintFill)} style={{ width: `${sprintPct}%` }} /></div>
      </div>
      <div className="ms-progress-row">
        <span style={{ minWidth: 96 }}>Tasks {tasksDone}/{tasksTotal} done</span>
        <div className="ms-bar"><span className={cn(taskFill)} style={{ width: `${taskPct}%` }} /></div>
      </div>
    </div>
  );
}
