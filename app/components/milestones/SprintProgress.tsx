import { cn } from "../ui/cn";
import { isSprintReadyToArchive, type SprintProgressCount } from "../../lib/progress";

// Pill "8/12 done"; green at 100% with "Ready to archive" emphasis.
export function SprintProgress({ done, total }: SprintProgressCount) {
  const ready = isSprintReadyToArchive({ done, total });
  return (
    <>
      <span className={cn("lane-progress", ready ? "lane-progress-done" : "lane-progress-running")}>
        {done}/{total} done
      </span>
      {ready && <span className="lane-ready">Ready to archive</span>}
    </>
  );
}
