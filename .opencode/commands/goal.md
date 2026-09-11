---
description: Run a goal to DONE — breakdown, design, protocol, lanes, verify, loop until achieved
---

Load the `goal` skill with the skill tool and follow it exactly, looping until the goal below is achieved. Park-and-report on blockers per the skill; halt only on secrets exposure.

Main session orchestrates only — never call `edit`/`write` on code or design docs (`app/`, `server/`, `shared/`, `cli/`, `wireframes/`, `docs/*.md`, skill/config). Every mutation goes to a herdr lane (simple → one lane; complex → one per track); `subagent` calls are read-only. Direct writes are allowed only on the `status/` tracking plane.

Goal: $ARGUMENTS
