// Write-tool names + caps, isolated from `write-tools.ts` so the Durable Object
// can import them without pulling the Bun-side write runtime (`@tanstack/ai`)
// into the Worker/DO bundle (ADR-0003). `write-tools.ts` re-exports these.

// Max write proposals per stream turn — further proposals in the same turn
// return a tool error result instead of persisting.
export const MAX_WRITES_PER_TURN = 8;

// Approval TTL (assistant_pending_writes.expires_at) — lazy sweep only.
export const APPROVAL_TTL_HOURS = 24;

// Max task refs per bulk call on the single-task write tools (archive/restore/
// delete). A bulk call still occupies one proposal slot (MAX_WRITES_PER_TURN)
// and one approval.
export const MAX_BULK_TASK_REFS = 100;

export const ASSISTANT_WRITE_TOOL_NAMES = [
  "create_task",
  "update_task",
  "move_task",
  "archive_task",
  "restore_task",
  "delete_task",
  "add_comment",
  "create_wiki_page",
  "edit_wiki_page",
  "delete_wiki_page",
  "create_milestone",
  "update_milestone",
  "archive_milestone",
  "delete_milestone",
  "create_sprint",
  "update_sprint",
  "archive_sprint",
  "delete_sprint",
  "move_swimlane",
] as const;

export type AssistantWriteToolName = (typeof ASSISTANT_WRITE_TOOL_NAMES)[number];
