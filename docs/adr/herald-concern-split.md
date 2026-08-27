# ADR: Herald concern split (chat vs task)

## Status
Accepted 2026-08-27

## Context
`server/services/herald.service.ts` handled both freeform chat (`runChatStream`/`resumeChatStream`, `activeChats`, `MAX_CHAT_TOOL_ROUNDS=24`) and task/wiki doc streams (`runStream`/`resumeThreadStream`, `activeTasks`, `MAX_TOOL_ROUNDS=12`, queue+approvals, writeTools drain) plus shared `buildStream`, stall watchdog, truncated tool-args salvage. Coupling caused chat stall to block task queue tests and made round caps/registries indistinguishable.

## Decision
Split into two Effect services with a thin facade for backwards compat:

- `server/services/herald-chat.service.ts` — `HeraldChatService` (`Lexa/HeraldChatService`): `activeChats`, `MAX_CHAT_TOOL_ROUNDS=24`, chat stream, resume, listChats, updateChatMeta, decideApproval, abortChat. Depends on repos/gateway/storage only; write-tool drain optional.
- `server/services/herald-task.service.ts` — `HeraldTaskService` (`Lexa/HeraldTaskService`): `activeTasks`, `MAX_TOOL_ROUNDS=12`, enqueue, runStream, resumeThreadStream, decideApproval, abortStream. Owns queue/approval drain.
- `server/herald/build-stream.ts` — shared `buildStream` factory (`StreamRunContext` -> `ReadableStream<StreamFrame>`) with `STREAM_STALL_TIMEOUT_MS=90s`, `shouldEmitToolFrame`, `stripToolCallXml`, `findPendingBatch`/`applyResumeResults`. Chat/task instantiate with own `toolRoundCap`/`registry`. No duplication of core loop/stall/salvage logic.
- `server/services/herald-helpers.ts` — pure helpers (`scanMentionTokens`, `resolveHeraldThread`, `buildChatSnippet`, etc.) re-exported via facade so `import { buildStream } from "./herald.service"` tests keep passing.
- `server/services/herald.service.ts` — thin facade `HeraldService` (`Lexa/Herald`) delegating to chat/task services, preserving `import { HeraldService }` for `server/api/http.ts` (no route change). `decideApproval` fans out to both (pendingWrites is shared table).
- Frontend cache keys already separate: `["herald-chats",projectId]` vs `["herald-thread",projectId,docType,docId]` — verified, no change.

No DB migration, no new service cycle (`Herald*` -> repos/gateway only; `TaskService` -> `GitHubService` cycle unchanged). Phase A hotfixes preserved (salvage `{"name":"v1","dueAt":` -> skip with `HERALD_TOOL_ARGS_INVALID`, stall watchdog, 404 demote).

## Alternatives considered
- Single service with internal branching — rejected, caps/registries stay coupled.
- Full duplication of `buildStream` per service — rejected, hotfix drift.
- Move `decideApproval` entirely to one side — rejected, pendingWrites serves both docTypes.

## Consequences
- `tsc --noEmit` passes, `herald.service.test.ts` 61 + `use-herald-stream.test.tsx` 15 green.
- `activeChats`/`activeTasks` isolated; chat stall cannot block task queue.
- Facade keeps existing imports green; future routes can import `HeraldChatService`/`HeraldTaskService` directly.
- Deviation: `Herald*Service` depends on `TaskService`/`CommentService`/etc for approved-write execution; `grep -r "TaskService" server/services/herald-*.ts` therefore hits via class/tag name and write executor — not a `TaskService->GitHubService` cycle, invariant preserved.

