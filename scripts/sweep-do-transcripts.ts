// Pre-cutover DO transcript sweep (ADR-0005 W4b / R6).
//
// The Durable Object was the canonical transcript store with D1
// `assistant_threads.messages` as a per-step mirror. After the W4 route flip the
// DO is dormant and D1 becomes the only store, so any thread whose DO holds a
// tail the mirror never received would lose that tail. This sweep reads the DO
// canonical transcript over the thread RPC (`getTranscript`), converts the
// UIMessage-parts shape to the D1 legacy-stored shape, and writes it back ONLY
// when the DO has MORE messages than D1 (the DO-only tail).
//
// Idempotent: a second run sees D1 already at least as long as the DO and skips.
// Fail-open: one thread's failure is logged and the sweep continues. Safe to run
// repeatedly while the flag is set (boot is per-isolate; each run is a no-op
// once drained).
//
// Run (deploy context — the DO binding lives only in the Workers runtime):
//   LXK_SWEEP_DO_TRANSCRIPTS=1  # set on the deploy, restart/redeploy, read logs
// See docs/CLOUDFLARE_WORKERS.md § "Pre-cutover DO transcript sweep".

import { getAgentByName } from "agents";
import { Effect } from "effect";
import { queryAll, run, type DbDriver } from "../server/db/db";
import { createD1Driver } from "../server/db/drivers/d1";
import { d1DatabaseToD1Like } from "../server/api/workers-ports";
import { legacyFromUIMessages } from "../server/assistant/legacy-convert";

export interface SweepThreadRow {
  documentType: string;
  documentId: string;
  projectId: string;
  messages: unknown;
}

export interface SweepTranscript {
  messages: unknown[];
  summary: string | null;
  summarizedCount: number | null;
  permissionMode: string;
}

export interface SweepDeps {
  listThreads(): Promise<SweepThreadRow[]>;
  getTranscript(threadKey: string): Promise<SweepTranscript | null>;
  writeTranscript(input: {
    documentType: string;
    documentId: string;
    messages: unknown[];
    summary: string | null;
    summarizedCount: number | null;
    permissionMode: string;
  }): Promise<void>;
  log(level: "INFO" | "WARN", message: string, meta?: Record<string, unknown>): void;
}

export interface SweepReport {
  scanned: number;
  imported: number;
  skipped: number;
  failed: number;
}

export function threadKeyFor(documentType: string, documentId: string): string {
  return `${documentType}:${documentId}`;
}

function storedCount(messages: unknown): number {
  if (Array.isArray(messages)) return messages.length;
  if (typeof messages === "string" && messages.trim() !== "") {
    try {
      const parsed = JSON.parse(messages) as unknown;
      return Array.isArray(parsed) ? parsed.length : 0;
    } catch {
      return 0;
    }
  }
  return 0;
}

// Pure core — no platform access, so the idempotency + fail-open contract is
// unit-testable with a bun:sqlite-backed deps set.
export async function sweepDoTranscripts(deps: SweepDeps): Promise<SweepReport> {
  const report: SweepReport = { scanned: 0, imported: 0, skipped: 0, failed: 0 };
  const threads = await deps.listThreads();
  for (const thread of threads) {
    report.scanned += 1;
    const key = threadKeyFor(thread.documentType, thread.documentId);
    try {
      const transcript = await deps.getTranscript(key);
      // No DO answered (thread never ran on the DO) — nothing to import.
      if (transcript === null) {
        report.skipped += 1;
        continue;
      }
      const d1Count = storedCount(thread.messages);
      if (transcript.messages.length <= d1Count) {
        // D1 already holds at least the DO tail — idempotent skip.
        report.skipped += 1;
        continue;
      }
      const legacy = legacyFromUIMessages(transcript.messages);
      await deps.writeTranscript({
        documentType: thread.documentType,
        documentId: thread.documentId,
        messages: legacy,
        summary: transcript.summary,
        summarizedCount: transcript.summarizedCount,
        permissionMode: transcript.permissionMode,
      });
      report.imported += 1;
      deps.log("INFO", "do-sweep imported DO-only tail", {
        threadKey: key,
        doCount: transcript.messages.length,
        d1Count,
      });
    } catch (e) {
      report.failed += 1;
      deps.log("WARN", "do-sweep thread failed", {
        threadKey: key,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return report;
}

// ─── Production wiring (Workers runtime) ─────────────────────────────────

interface D1Like {
  prepare: (sql: string) => unknown;
  exec?: unknown;
  batch?: unknown;
}

export interface SweepEnv {
  DB?: unknown;
  ASSISTANT_AGENT?: unknown;
}

interface AgentStub {
  getTranscript(): Promise<SweepTranscript>;
}

export async function runSweepDoTranscripts(env: SweepEnv): Promise<SweepReport | null> {
  if (!env.DB || !env.ASSISTANT_AGENT) return null;
  const driver: DbDriver = createD1Driver(d1DatabaseToD1Like(env.DB as D1Like as never));
  const namespace = env.ASSISTANT_AGENT as Parameters<typeof getAgentByName>[0];
  const log = (level: "INFO" | "WARN", message: string, meta?: Record<string, unknown>) => {
    const line = JSON.stringify({ level, service: "do-sweep", message, ...(meta ? { meta } : {}), timestamp: new Date().toISOString() });
    if (level === "WARN") console.warn(line);
    else console.log(line);
  };
  return sweepDoTranscripts({
    listThreads: () =>
      Effect.runPromise(
        queryAll<{ document_type: string; document_id: string; project_id: string; messages: unknown }>(
          driver,
          "SELECT document_type, document_id, project_id, messages FROM assistant_threads"
        )
      ).then((rows) =>
        rows.map((r) => ({ documentType: r.document_type, documentId: r.document_id, projectId: r.project_id, messages: r.messages }))
      ),
    getTranscript: async (threadKey) => {
      const stub = (await getAgentByName(namespace, threadKey)) as unknown as AgentStub;
      return stub.getTranscript();
    },
    writeTranscript: async (input) => {
      await Effect.runPromise(
        run(
          driver,
          `UPDATE assistant_threads
             SET messages = ?, summary = ?, summarized_count = ?, permission_mode = ?, updated_at = datetime('now')
           WHERE document_type = ? AND document_id = ?`,
          JSON.stringify(input.messages),
          input.summary,
          input.summarizedCount ?? 0,
          input.permissionMode,
          input.documentType,
          input.documentId
        )
      );
    },
    log,
  });
}

// CLI guard: `bun run` prints the invocation contract. The sweep needs the DO
// binding, which only exists inside the Workers runtime — it is triggered from
// the worker boot (workers-entry.ts) when LXK_SWEEP_DO_TRANSCRIPTS=1, not from a
// bare local process.
if (import.meta.main) {
  console.log(
    [
      "sweep-do-transcripts: run in the Workers deploy context.",
      "Set LXK_SWEEP_DO_TRANSCRIPTS=1 on the deploy, redeploy/restart, read the",
      "'do-sweep' log lines for the report, then unset it.",
      "See docs/CLOUDFLARE_WORKERS.md § Pre-cutover DO transcript sweep.",
    ].join("\n")
  );
}
