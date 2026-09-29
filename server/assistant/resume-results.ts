import { Effect } from "effect";
import type { ResumeResultLine } from "./build-stream";

// Shared by the chat and task resume paths: both replay a decided approval
// batch, so the executed-write collection lives here once.

export type ResumeResult = { approvalId: string; status: "applied" | "failed" | "denied"; error?: string };

interface ResumeRow {
  id: string;
  tool_name: string;
  args: string;
  status: string;
}

type WriteOutcome = { ok: true; result: unknown } | { ok: false; error?: string | undefined };

// Human label for a pending write: the first non-empty identifier in its args.
export function targetOf(row: { args: string }): string | undefined {
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(row.args) as Record<string, unknown>; } catch { return undefined; }
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
          results.push({ approvalId: row.id, status: "applied" });
          const createdKey = row.tool_name === "create_task" ? (outcome.result as { task?: { key?: unknown } } | undefined)?.task?.key : undefined;
          noteLines.push({ tool: row.tool_name, target: targetOf(row), ...(typeof createdKey === "string" && createdKey !== "" ? { created: createdKey } : {}), status: "applied" });
        } else {
          results.push({ approvalId: row.id, status: "failed", ...(outcome.error !== undefined ? { error: outcome.error } : {}) });
          noteLines.push({ tool: row.tool_name, target: targetOf(row), status: "failed", ...(outcome.error !== undefined ? { error: outcome.error } : {}) });
        }
      } else if (row.status === "rejected") {
        results.push({ approvalId: row.id, status: "denied" });
        noteLines.push({ tool: row.tool_name, target: targetOf(row), status: "denied" });
      }
    }
    return { results, noteLines };
  });
