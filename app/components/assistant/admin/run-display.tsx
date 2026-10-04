import { parseApiDate } from "../../../lib/date";
import type { AssistantRunStatus } from "../../../lib/api";

// Shared display helpers for the admin runs + calls tables.

export function formatTimestamp(iso: string | null | undefined, opts?: { seconds?: boolean }): string {
  if (!iso) return "—";
  const d = parseApiDate(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const two = (n: number) => String(n).padStart(2, "0");
  const clock = opts?.seconds === false
    ? `${two(d.getHours())}:${two(d.getMinutes())}`
    : `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const now = new Date();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (dayDiff === 0) return `Today ${clock}`;
  if (dayDiff === 1) return `Yesterday ${clock}`;
  return `${d.toLocaleDateString()} ${clock}`;
}

export function formatDuration(startedAt: string | null, finishedAt: string | null): string {
  if (!startedAt || !finishedAt) return "—";
  const start = parseApiDate(startedAt).getTime();
  const end = parseApiDate(finishedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "—";
  return `${Math.max(0, Math.round((end - start) / 1000))}s`;
}

const runStatusMeta: Record<AssistantRunStatus, { label: string; color: string }> = {
  completed: { label: "Done", color: "var(--lx-text-success)" },
  running: { label: "Running", color: "var(--lx-text-warning)" },
  failed: { label: "Failed", color: "var(--lx-text-danger)" },
  queued: { label: "Queued", color: "var(--lx-text-muted)" },
  cancelled: { label: "Cancelled", color: "var(--lx-text-muted)" },
};

export function RunStatusChip({ status }: { status: AssistantRunStatus }) {
  const meta = runStatusMeta[status];
  return (
    <span className="status-chip" style={{ cursor: "default" }}>
      <span className="status-dot" style={{ background: meta.color }} />
      {meta.label}
    </span>
  );
}

// Runs table label: the union row carries both `kind` (chat_run/document/
// schedule) and `documentType` (task/wiki/null). chat_run/schedule rows have no
// document, so they must never be labelled "Wiki" nor linked to an empty slug.
export function runKindLabel(r: { kind?: string | undefined; documentType?: "task" | "wiki" | null | undefined }): string {
  if (r.kind === "schedule") return "Schedule";
  if (r.kind === "chat_run") return "Chat";
  if (r.documentType === "task") return "Task";
  if (r.documentType === "wiki") return "Wiki";
  return "Chat";
}

// Navigable document target, or null for chat/schedule rows (no document) and
// rows whose document id is missing.
export function runDocumentTarget(r: { documentType?: "task" | "wiki" | null | undefined; documentId: string; key: string }): { kind: "task" | "wiki"; value: string } | null {
  if (r.documentType !== "task" && r.documentType !== "wiki") return null;
  const id = r.documentId.trim();
  if (!id) return null;
  return { kind: r.documentType, value: r.documentType === "task" ? r.key || id : id };
}
