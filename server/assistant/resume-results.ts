import { Effect } from "effect";
import type { ResumeResultLine } from "./build-stream";
import type { ApprovalPartial } from "../../shared/assistant";

// Shared by the chat and task resume paths: both replay a decided approval
// batch, so the executed-write collection lives here once.

export type ResumeResult = { approvalId: string; status: "applied" | "failed" | "denied"; error?: string; partial?: ApprovalPartial };

interface ResumeRow {
  id: string;
  tool_name: string;
  args: string;
  status: string;
}

type WriteOutcome = { ok: true; result: unknown } | { ok: false; error?: string | undefined };

// A bulk executor result is `{ applied, failed, partial: true }` (see
// write-execution.ts runBulkTaskOp). Surface the failure counts so a partially
// applied batch is never reported as fully applied.
function partialOfResult(result: unknown): ApprovalPartial | undefined {
  if (result === null || typeof result !== "object") return undefined;
  const r = result as { partial?: unknown; applied?: unknown; failed?: unknown };
  if (r.partial !== true || !Array.isArray(r.applied) || !Array.isArray(r.failed) || r.failed.length === 0) return undefined;
  const errors: string[] = [];
  for (const f of r.failed) {
    const err = (f as { error?: unknown } | null)?.error;
    if (typeof err === "string" && err.trim() !== "" && !errors.includes(err)) errors.push(err);
  }
  return { applied: r.applied.length, failed: r.failed.length, ...(errors.length > 0 ? { errors } : {}) };
}

// Human label for a pending write: bulk ref lists summarize as "<n> tasks",
// otherwise the first non-empty identifier in its args.
export function targetOf(row: { args: string }): string | undefined {
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(row.args) as Record<string, unknown>; } catch { return undefined; }
  const refs = args["refs"];
  if (Array.isArray(refs)) {
    const seen = new Set<string>();
    for (const r of refs) {
      if (typeof r !== "string") continue;
      const t = r.trim();
      if (t !== "") seen.add(t);
    }
    if (seen.size > 0) return `${seen.size} tasks`;
  }
  for (const key of ["ref", "title", "slug", "name", "swimlaneId", "milestoneId"]) {
    const v = args[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return undefined;
}

// Execute the approved rows of a batch in order, collecting the per-approval
// results and the provider-context note lines (rejected rows are reported, not
// executed).
export const collectResumeResults = <R extends ResumeRow, E, Req>(
  rows: readonly R[],
  run: (row: R) => Effect.Effect<WriteOutcome, E, Req>
): Effect.Effect<{ results: ResumeResult[]; noteLines: ResumeResultLine[] }, E, Req> =>
  Effect.gen(function* () {
    const results: ResumeResult[] = [];
    const noteLines: ResumeResultLine[] = [];
    for (const row of rows) {
      if (row.status === "approved") {
        const outcome = yield* run(row);
        if (outcome.ok) {
          const partial = partialOfResult(outcome.result);
          results.push({ approvalId: row.id, status: "applied", ...(partial !== undefined ? { partial } : {}) });
          const createdKey = row.tool_name === "create_task" ? (outcome.result as { task?: { key?: unknown } } | undefined)?.task?.key : undefined;
          noteLines.push({ tool: row.tool_name, target: targetOf(row), ...(typeof createdKey === "string" && createdKey !== "" ? { created: createdKey } : {}), status: "applied", ...(partial !== undefined ? { partial } : {}) });
        } else {
          results.push({ approvalId: row.id, status: "failed", ...(outcome.error !== undefined ? { error: outcome.error } : {}) });
          noteLines.push({ tool: row.tool_name, target: targetOf(row), status: "failed", ...(outcome.error !== undefined ? { error: outcome.error } : {}) });
        }
      } else if (row.status === "rejected") {
        results.push({ approvalId: row.id, status: "denied" });
        noteLines.push({ tool: row.tool_name, target: targetOf(row), status: "denied" });
      } else if (row.status === "expired") {
        // Expired rows never ran and carry no approval result; report them in
        // the note so a mixed batch is not silently missing them.
        noteLines.push({ tool: row.tool_name, target: targetOf(row), status: "expired" });
      }
    }
    return { results, noteLines };
  });

// Note lines for a fully-decided batch with no approved rows (all
// rejected/expired). The DO resumes the turn on this note so the user is never
// left with silent feedback.
export function settledNoteLines(
  rows: readonly Pick<ResumeRow, "tool_name" | "args" | "status">[]
): ResumeResultLine[] {
  const lines: ResumeResultLine[] = [];
  for (const row of rows) {
    if (row.status === "rejected") lines.push({ tool: row.tool_name, target: targetOf(row), status: "denied" });
    else if (row.status === "expired") lines.push({ tool: row.tool_name, target: targetOf(row), status: "expired" });
  }
  return lines;
}
