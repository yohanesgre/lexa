---
name: work-plans
description: Per-plan work tracking in status/ folders — open, update, and close work plans with lane heartbeats, chronological TIMELINE, and memory links. Use whenever the user mentions work plans, status plans, opening or closing a plan, plan stubs, lanes inside a plan, plan templates, TIMELINE.md, or organizing status/ artifacts per plan instead of flat files — even if they don't say "work-plans".
---

# Work Plans

One folder per plan under `status/`. A plan is a unit of work (a feature, a fix batch,
a grind). Lanes live inside the plan only when parallel tracks need separate heartbeats.
Single-track plans skip `lanes/` entirely — never invent a lane to fill the shape.

## Layout

```
status/
  TIMELINE.md                # append-only, one line per event
  <plan>/                    # name: [a-z0-9-] (e.g. deploy-dashboard)
    plan.md                  # X, scope, graph — written once at open
    status.md                # 3-line heartbeat, overwritten on every action
    lanes/                   # ONLY when parallel; one 3-line file per lane
      <lane>.md
    report.md                # written once at close (DONE | FAILED)
```

`ls status/` must show active plans only. No loose files in `status/` root except
`TIMELINE.md`. Finished plans stay in place until explicitly archived
(`status/archive/YYYY-MM-DD-<plan>/`); archiving is a move of the whole folder.

## Open a plan

Copy `assets/plan-template.md` to `status/<plan>/plan.md` and fill it in.

States: `PLAN | WAIT | WORKING | DONE | FAILED` (mirror of AGENTS.md).
`WAIT` = blocked, msg names the blocker. `FAILED` = closed without meeting
scope within budget; `report.md` is still required.

Header fields: `gate:` = execution-gate ack (`<ISO8601> <who> <branch>`)
when a gated flow (e.g. `/goal`) drives the plan; `iter:` = current
`W<n>i<m>` loop position. Omit when unused.

`plan.md` is the plan of record for the flow that opened it. Design/plan
artifacts produced elsewhere (specs, ADRs, project plan docs) are inputs —
link them, never duplicate them here.

Then write `status/<plan>/status.md`:

```
state: PLAN
ts: <epoch>
msg: <one line: what + why>
```

Append one line to `status/TIMELINE.md`:

```
YYYY-MM-DD | <plan> | PLAN | <one line> | status/<plan>/plan.md
```

Why the 3-line heartbeat: readers (human or agent) see plan state in one glance
without opening the full plan. Detail lives in `plan.md`, never in `status.md`.

## Work the plan

On every significant action, overwrite `status.md` with fresh `ts`:

```
state: WORKING
ts: <epoch>
msg: <one line: latest step>
```

Blocked → `state: WAIT` with a msg naming the blocker; never leave a blocked
plan silently WORKING. Lane files use the same states.

Multi-track: one file per lane under `lanes/` in the same 3-line format.
The plan-level `status.md` stays the summary — it mirrors the slowest lane, it never
dumps lane logs. Lane files stay small for the same reason as `status.md`.

Reopened work flips out of DONE first: any new request on a DONE plan (commit,
fixup, follow-up) → overwrite `status.md` to WORKING/WAIT before acting, then
append a TIMELINE line. Never act on a DONE plan while it still reads DONE.

## Close a plan (DONE)

1. Write `status/<plan>/report.md`:

```md
# Report: <plan>
created: YYYY-MM-DD
sessions: <session ids>
result: <what shipped, where>
tests: <command + one-line output each>
deviations: <contract breaks, or "none">
```

2. Flip `status.md` to `state: DONE` with fresh `ts`.
3. Append TIMELINE line with `DONE` and the report path.
4. Save to memory (engram `mem_save`): 3–5 point summary + artifact paths
   (`plan.md`, `report.md`). Never duplicate full report content into memory —
   memory is the index, the files are the source.

## Close a plan (FAILED)

Acceptance can't be met within budget: write `report.md` the same way
(`result: failed — <what shipped>; blockers: ...`), flip `status.md` to
`state: FAILED`, append the TIMELINE line. A plan never stays WORKING after
effort stops.

## Chronology

Three sources, in order of convenience: `TIMELINE.md`, folder/archive names with
`YYYY-MM-DD` prefixes, `git log -- status/`. The graph still works when any one
is missing (no gate), so a forgotten TIMELINE line is a minor escape, not a break —
just backfill it when noticed.

## Break points (fix the artifact, not the reader)

| Node | Break | Treatment |
|---|---|---|
| open | `plan.md` without scope Out | add Non-scope before work starts |
| work | `status.md` grows past 3 lines / log dump | move detail to `plan.md` or `report.md` |
| lanes | lane file with no parent plan | delete or attach to a plan |
| DONE | no `report.md` | don't flip to DONE until written |
| FAILED | no `report.md` | write `report.md`, then flip FAILED |
| state | undefined value (e.g. `PARTIAL`) | use the AGENTS.md enum; FAILED + blockers |
| reopen | act on a DONE plan without flipping status | flip to WORKING first + TIMELINE line |
| memory | `mem_save` without artifact path | amend with path — a pointerless summary is lost |
| root | loose file in `status/` | move into a plan folder or archive |

## Validate

Run `bash .agents/skills/work-plans/scripts/plan-check.sh <plan>` at
open and before flipping DONE/FAILED. It checks scope Out, 3-line
heartbeats, TIMELINE entry, no loose files, and DONE-has-report.
Red → fix the artifact, then re-run.

## Non-scope

This skill never touches app code, `server/`, `shared/`, `docs/`, or `wireframes/`.
It never commits, pushes, or merges — hand that to `git-workflow`.
Plan names use `[a-z0-9-]`; anything else is rejected at the boundary.
