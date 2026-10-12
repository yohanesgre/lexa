// Tool-round budgets and the per-tool-call timeout, isolated from `tools.ts` so
// the Durable Object can import them without pulling the Bun-side tool runtime
// (`@tanstack/ai`, `unpdf`) into the Worker/DO bundle (ADR-0003). `tools.ts`
// re-exports the budgets for the Bun path.

export const MAX_TOOL_ROUNDS = 12;
export const MAX_CHAT_TOOL_ROUNDS = 24;

// Lexa-owned model-iteration cap (the second half of M3): the model-turn loop
// inside one `chat()` call is bounded by an agent-loop strategy Lexa passes,
// instead of the SDK's unpinned `maxIterations(5)` default — an SDK upgrade must
// not silently change how many model round-trips a turn may spend. 5 is the
// value that default resolved to; the tool-round caps above count tool CALLS
// (several calls can ride one model turn), so they never bounded this.
export const MAX_MODEL_ITERATIONS = 5;

// Per-call ceiling for the local (DB-backed) read and write tools (M5). Every
// remote tool already carries its own timeout (MCP 30s, fetch_url / web_search
// 15s, vision 60s, Jev 10s); the local ones had none, so a stuck query was
// bounded only by the inter-chunk stall watchdog. A call that exceeds this
// rejects with a model-readable error result — the turn keeps running instead
// of hanging, and the model can retry or report.
export const LOCAL_TOOL_TIMEOUT_MS = 20_000;

interface LocalToolLike {
  name?: unknown;
  execute?: unknown;
}

/**
 * Bound one local tool's `execute` with a wall-clock timeout. Note the limit's
 * shape: the SDK feeds the rejection to the model as a tool error result, it
 * does NOT abort the underlying operation (a synchronous SQLite read cannot be
 * interrupted), so the timeout bounds the turn's WAIT, not the query.
 * Applied to every local tool as its toolset is built.
 */
export function withToolTimeout<T extends LocalToolLike>(tool: T, ms: number = LOCAL_TOOL_TIMEOUT_MS): T {
  const execute = tool.execute as ((input: never, context?: never) => Promise<unknown>) | undefined;
  if (typeof execute !== "function") return tool;
  const name = typeof tool.name === "string" ? tool.name : "tool";
  return {
    ...tool,
    execute: async (input: never, context?: never): Promise<unknown> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          execute(input, context),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${name} timed out after ${ms}ms`)), ms);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  } as T;
}
