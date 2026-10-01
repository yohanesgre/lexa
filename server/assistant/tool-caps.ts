// Tool-round budgets, isolated from `tools.ts` so the Durable Object can import
// them without pulling the Bun-side tool runtime (`@tanstack/ai`, `unpdf`) into
// the Worker/DO bundle (ADR-0003). `tools.ts` re-exports these for the Bun path.

export const MAX_TOOL_ROUNDS = 12;
export const MAX_CHAT_TOOL_ROUNDS = 24;
