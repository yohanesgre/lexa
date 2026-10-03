// Tool-round budgets, isolated from `tools.ts` so the Durable Object can import
// them without pulling the Bun-side tool runtime (`@tanstack/ai`, `unpdf`) into
// the Worker/DO bundle (ADR-0003). `tools.ts` re-exports these for the Bun path.

import { stepCountIs, type StopCondition, type ToolSet } from "ai";

export const MAX_TOOL_ROUNDS = 12;
export const MAX_CHAT_TOOL_ROUNDS = 24;
// Delegated runner cap (ADR-0004 §3; plan `Limits`): the runner is capped at 16
// steps regardless of document type — 12/24 stay the regular-turn budgets.
export const MAX_RUNNER_STEPS = 16;

/**
 * Stop condition for a delegated runner turn. Exported (not inlined in
 * `runner.ts`) so the cap is unit-testable without importing the facet class
 * (which pulls `@cloudflare/ai-chat` / `cloudflare:workers`).
 */
export function runnerStopWhen(): StopCondition<ToolSet>[] {
  return [stepCountIs(MAX_RUNNER_STEPS)];
}
