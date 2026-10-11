---
version: 1
slug: "app-routes-index-tsx"
primary_target: "app/routes/index.tsx"
related_targets: ["app/components/layout/AppShell.tsx"]
---

## Direction contract

seed `b2d212c2` · mode **operate** · build **code-led** (no comps) · candidate 6 of the grounded seven

**THESIS.** The tracker reads as one surveyed mountain: work descends from milestone peaks to the `Done` valley and every state wears plain trail signage. It refuses the dark-SaaS-tracker-with-one-accent default and the incumbent amber-CRT look.

**OWN-WORLD.** Ground: floodlit slate `#10161B` (night, default) / map paper `#F2EFE7` (day, `[data-theme="light"]`, the existing theme switch kept). Panels `#18222B` / `#FBFAF6`. Rail `#0B1014` / `#E9E4D8`. Ink snow-white `#EAF2F6` / `#17222B`; secondary ink `#9FB2BE` / `#5A6B76`. **Brand amber `#F0C040`** (day fill `#D4A017`, ink amber `#7E5C00` for marks and links) carries primary action, focus ring, and the today marker. Priority is drawn as ski-run **difficulty ribbons** (lowest green `#2E9E4F`, normal blue `#2F74D0`, high red `#D2372F`, highest black), each doubled by its rank numeral and the project's configured priority name in the accessible label. Series hues (glacier cyan `#35B7C8`, sun gold `#E8A33D`, plum `#9A5BD0`, meadow green `#2E9E4F`) are for per-project/data series only; state colours appear only where they mean something. Three type voices: **Signage** (grotesque caps, tracked) for nav, section plates and buttons; **Guide** (humanist sans) for body and copy; **Surveyor** (tabular numerals, mono/condensed) for keys, counts, dates. Rows 36px desktop / 44px touch, tabular figures in every count, panels flat, only overlays lifted.

**STORY.** Understand: our work is one mountain — milestones are peaks, sprints the runs, tasks numbered posts with a difficulty band, lifts the hand-offs and blocks. Believe: the map is surveyed, not decorated — dates are altitudes, a closed lift is a real block, the sync stamp shows when GitHub last agreed. Do: read the trail report, clear the needs-attention list, take my run, trace a task's route, open Board.

**FIRST VIEWPORT.** 1440×900 shell + dashboard, six regions in order: shell rail + top bar · trail report strip · trail profile panel (the signature) · needs attention · column WIP meters · recent movement. Every region draws its void states (empty / loading / error / long content) before layout; content is real (`Nimbus`, `acme/nimbus`, seeded task titles).

**FORM + SIGNATURE.** The **Trail Profile** panorama — milestone progress as a mountain, target dates as altitude, sprints descending, `You are here` pinned at today — with hover/focus **Route Trace**: a task's descent from its milestone peak through its sprint run and its `blocked-by` gates to `Done`, 180ms linear, instant under reduced motion; click still opens the standard slideover.

**MOBILE (required, not optional).** Mobile is a designed state, not a squeeze. Below 768px: the rail becomes a labelled menu (never a bare hamburger with the only route hidden in it); the trail report stays one horizontally scrollable strip; the profile becomes a horizontal strip pinned at today; then needs-attention; then WIP meters. 44×44px minimum targets with spacing between them; every hover-only affordance has a tap equivalent with visible `:active` feedback; zero horizontal overflow; compact chrome that never covers content (scroll padding + safe-area insets where fixed). Verify at 390px and confirm the desktop first viewport still holds at 1440.

**FINISH.** "unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance."
