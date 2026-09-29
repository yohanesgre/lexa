# Report: assistant-write-intent

state: DONE
ts: 1790671207

## Defects fixed

1. **Write-intent regex missed `delete`/`remove`** — `ASSISTANT_WRITE_INTENT_RE`
   (`server/services/assistant-helpers.ts:121`) and its duplicate
   `WRITE_INTENT_RE` (`server/assistant/build-stream.ts:14`). "can you remove
   all tasks?" never matched, so `modelOptionsWithWriteIntent`
   (`assistant-helpers.ts:127`) never set `tool_choice: "required"` and the
   model narrated.
   - Fix: added `delete|remove` (kept `hapus`) and made the noun group
     plural-tolerant (`(milestone|sprint|task|wiki|page|comment)s?`). Plural
     tolerance is required: `\btask\b` does not match "tasks", so a bare
     verb addition would still fail "remove all tasks".
   - **Single-sourced**: `build-stream.ts` now imports
     `ASSISTANT_WRITE_INTENT_RE` from `../services/assistant-helpers` and
     re-exports it as `WRITE_INTENT_RE = ASSISTANT_WRITE_INTENT_RE` (both
     exports preserved; grep showed no other importer of the local const).
     The two sites can no longer drift.
   - Repro (before/after): `bun -e` regex probe — old regex false / new true
     for "can you remove all tasks?", "delete task X", "please remove the
     task"; negatives unchanged false.

2. **Dishonest log** — `server/assistant/build-stream.ts:563` said
   `"write tools offered but no tool called"` with `meta.writeTools` (writes
   only), reading as if no tools were offered.
   - Fix: message now
     `"assistant answered without a tool call (read and write tools were
     offered)"`; meta adds `offeredTools` (total offered = `ctx.tools.length`)
     and `readTools` (offered names excluding write tools and the internal
     `analyze_image`). No test existed for this log line (grep
     `write tools offered` → only the source), so none updated.

3. **Docs drift** — `docs/LAYERS.md:1330-1334` listed 13 write tools;
   `ASSISTANT_WRITE_TOOL_NAMES` (`server/assistant/write-tools.ts:18-38`) has
   19.
   - Fix: list refreshed to all 19 names transcribed exactly from the
     constant (`create_task`, `update_task`, `move_task`, `archive_task`,
     `restore_task`, `delete_task`, `add_comment`, `create_wiki_page`,
     `edit_wiki_page`, `delete_wiki_page`, `create_milestone`,
     `update_milestone`, `archive_milestone`, `delete_milestone`,
     `create_sprint`, `update_sprint`, `archive_sprint`, `delete_sprint`,
     `move_swimlane`); count 13 → 19.
   - `docs/API.md`: does NOT enumerate assistant write tools. Its only
     write-tool mention is the `tool_pending` example (`"name":"create_task"`,
     `docs/API.md:1907`), which stays correct. No change needed.
   - `docs/API.md:2064` already documents `get_all_tasks` correctly — no new
     tool added.

## Tests

New `server/services/assistant-helpers.test.ts` (no prior intent test
existed):
- positives: "can you remove all tasks?", "delete task X", "please remove the
  task", "hapus semua task", "create a milestone called v2", "tambah sprint",
  "update the wiki page" → true in **both** regexes.
- negatives: "how many tasks are there?", "what tasks are in the backlog?",
  "what is the status of the wiki page?", "show me the board", "" → false.
- identity assert: `WRITE_INTENT_RE === ASSISTANT_WRITE_INTENT_RE`
  (single-sourcing guard).
- `modelOptionsWithWriteIntent`: `tool_choice: "required"` with intent +
  writes enabled, base options merged, undefined for read-only question,
  undefined when no write tools enabled.

## Verification (exact)

```
./node_modules/.bin/tsc --noEmit        → exit 0 (no output)
bun run test:be                         → 143 test files passed, 1725 tests passed
bun run test:fe                         → 98 test files passed, 680 tests passed
./node_modules/.bin/vitest run server/services/assistant-helpers.test.ts → 1 file, 4 tests passed
```

## Deviations

- Plural tolerance (`s?`) added to the noun group — beyond the literal
  "add delete|remove" instruction, but required to satisfy the mandated
  test "can you remove all tasks?" (`\btask\b` ≠ "tasks").
- Merged the old 2nd/3rd alternations into one
  (`\b(bikin|buat|create|delete|remove)\s+(milestone|sprint|task|wiki)s?\b`) —
  a strict superset of the previous forms; verified negatives unchanged.
- `docs/API.md` needed no edit (no write-tool enumeration there).
- Untouched per plan: `get_all_tasks` (already exists), approval/carousel
  files, `app/lib/use-assistant-stream.ts` toolLabel copy.
- No commits.

## Concerns

- Intent detection stays a heuristic: adding `remove` widens it, so question
  phrasings that use a listed verb ("how do I remove a task from a sprint?")
  now also force `tool_choice: "required"`. Conservative direction (forces a
  tool call), matches the pre-existing behavior for `create`/`update`.
- `HALLUCINATION_RE` is still duplicated between `build-stream.ts:13` and
  `assistant-helpers.ts:120` (`ASSISTANT_HALLUCINATION_RE`) — same drift class,
  out of this lane's scope; left as-is.
- `.agents/memory/swe.md` is not covered by `.gitignore` (repo hygiene, not
  touched here).
