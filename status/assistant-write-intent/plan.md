# Plan: assistant-write-intent
created: 2026-09-29
state: PLAN

## X (problem)
User report: "can you remove all tasks?" → the assistant replies "let me grab the full list of tasks first" with NO tool call; the log says `write tools offered but no tool called`. Investigation (researcher ses_f13b55202ffeMHARJIufzg4FZi) proves the read tool EXISTS: `get_all_tasks` (`server/assistant/tools.ts:470`) is offered on every turn (`server/services/assistant-chat.service.ts:314`) and documented (`docs/API.md:2064`, `docs/LAYERS.md:1320`). The real defects:
1. `ASSISTANT_WRITE_INTENT_RE` (`server/services/assistant-helpers.ts:121-122`) and its duplicate `WRITE_INTENT_RE` (`server/assistant/build-stream.ts:14-15`) miss `remove`/`delete` → `modelOptionsWithWriteIntent` does not set `tool_choice: "required"` for "remove all tasks", so the model narrates instead of calling the read tool.
2. The log string (`build-stream.ts:563`) says "write tools offered but no tool called" and its `meta.writeTools` lists writes only — a misleading signal.
3. Docs drift: `docs/LAYERS.md:1330-1334` lists 13 write tools while `ASSISTANT_WRITE_TOOL_NAMES` (`server/assistant/write-tools.ts:18-38`) has 19; `docs/API.md` write-tool section likely the same.

## Scope
- In: add `delete|remove` to the intent regex (both sites; single-source if low-risk — build-stream already imports from assistant-helpers); unit tests incl. "can you remove all tasks?" and negative controls; make the log message/meta honest (no false "tools missing" signal); refresh the write-tool lists in `docs/LAYERS.md` + `docs/API.md` to exactly match `ASSISTANT_WRITE_TOOL_NAMES`; lane tests + gate.
- Out (explicit non-scope): adding any new tool (`get_all_tasks` and the rest of the read set already exist — do not add `list_tasks`); approval-flow changes; carousel lane files; `app/lib/use-assistant-stream.ts` toolLabel copy (only if the wireframes already carry such strings — otherwise defer to design); commits.

## Graph A
```ts
regex + log + docs + tests → tsc + test:be/test:fe green → gate → report
```

## E (break points)
| Node | Break | Treatment |
|---|---|---|
| regex | single-sourcing the duplicate breaks build-stream usages | keep both in sync instead; note it |
| docs | write-tool lists differ from code beyond count | transcribe from the constant exactly; no invented descriptions |
| log | meta lacks a read-tool count in context | smallest honest rewrite of the message only |

## R
- evidence: researcher ses_f13b55202ffeMHARJIufzg4FZi; log lines quoted in X
- memory: recall at open · store on DONE (summary + plan/report paths)
- tests: `bun run test:be`, `bun run test:fe`; gate via steward

## Memory
- `icm_memory_store` on DONE: summary + paths to `status/assistant-write-intent/plan.md` and `report.md`
