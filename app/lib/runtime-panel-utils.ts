import type { RuntimeTask, RuntimeTaskStatus, Runtime } from "../../shared/types";

export const STATUS_ORDER: RuntimeTaskStatus[] = ["queued", "running", "completed", "failed", "cancelled"];

// Total run count for the pagination line ("Showing 5 of 26 runs"). The
// history response carries the global per-status summary (no total field),
// so sum the statuses — matching the wireframe's "of N runs" copy.
export function historyTotal(summary: Record<RuntimeTaskStatus, number> | undefined): number | null {
  if (!summary) return null;
  return STATUS_ORDER.reduce((n, s) => n + (summary[s] ?? 0), 0);
}

export function paginationLabel(pageLength: number, total: number | null): string {
  if (pageLength === 0) return "End of history";
  return total !== null ? `Showing ${pageLength} of ${total} runs` : `Showing ${pageLength} runs`;
}

// Wireframe runtime-popover.html:86 — the running line is
// "<runtime> · <provider> · <skill>" once a runtime has claimed the task.
export function runLabel(taskData: RuntimeTask | null, runtimes: Runtime[]): string {
  if (!taskData?.runtimeId) return "Queued…";
  const runtime = runtimes.find((r) => r.id === taskData.runtimeId);
  const meta = [runtime?.name, runtime?.provider, taskData.skillName].filter(Boolean).join(" · ");
  return meta || "Agent working…";
}
