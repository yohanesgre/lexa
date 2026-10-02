// Write-tool caps + the canonical name list, isolated from `write-tools.ts` so
// the Durable Object can import them without pulling the Bun-side write runtime
// (`@tanstack/ai`) into the Worker/DO bundle (ADR-0003). The list itself lives
// in the pure `shared/assistant.ts` module (types + data only, DO-safe) and is
// re-exported here; `write-tools.ts` re-exports these.

import { ASSISTANT_WRITE_TOOL_NAMES } from "../../shared/assistant";

export { ASSISTANT_WRITE_TOOL_NAMES };

// Max write proposals per stream turn — further proposals in the same turn
// return a tool error result instead of persisting.
export const MAX_WRITES_PER_TURN = 8;

// Approval TTL (assistant_pending_writes.expires_at) — lazy sweep only.
export const APPROVAL_TTL_HOURS = 24;

// Max task refs per bulk call on the single-task write tools (archive/restore/
// delete). A bulk call still occupies one proposal slot (MAX_WRITES_PER_TURN)
// and one approval.
export const MAX_BULK_TASK_REFS = 100;

export type AssistantWriteToolName = (typeof ASSISTANT_WRITE_TOOL_NAMES)[number];
