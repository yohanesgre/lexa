---
version: 1
slug: "shell-rail"
primary_target: "app/components/layout/AppShell.tsx"
related_targets: ["app/styles/phosphor.css", "app/components/chat/AssistantChatShell.tsx", "app/components/chat/ThreadsSidebar.tsx", "app/components/wiki/WikiLayout.tsx", "app/components/wiki/WikiPageSidebar.tsx", "app/routes/$slug/chat.tsx", "app/routes/$slug/wiki/index.tsx", "app/routes/$slug/wiki/$pageSlug.tsx"]
---

# Shell Rail — surface brief

## Direction contract

seed `shell-refine-1` · mode **operate** · build **code-led** (no comps) · a refinement of the shipped Trail Map, not a new visual world

**THESIS.** One shell, not two surfaces. The shell is one frame: a single cap band across the top of the window, one continuous left system down the side, one content lane in the middle. Today the rail's head band is 40px against the top bar's 48px and their hairlines cross at (200, 48) — two surfaces glued together; on chat and wiki a second 260px band follows the 200px rail and reads as a second sidebar. This brief resolves the composition — band, seam, pane, measure — inside the locked Trail Map world: same tokens, same three type voices, same nav model (7 links + Chat), same copy voice, same dashboard six-region contract. Nothing outside the shell changes.

**OWN-WORLD (inherited, not re-litigated).** Ground floodlit slate `#10161B` (night, default) / map paper `#F2EFE7` (day). Rail and top bar ride `--lx-surface-rail` (`#0B1014` / `#E9E4D8`). Panels `#18222B` / `#FBFAF6`. Ink snow-white `#EAF2F6` / `#17222B`; secondary ink `#9FB2BE` / `#5A6B76`; muted ink `#7E929F` / `#5F707B`. **Patrol orange `#E4572E`** (day `#C7431E`) is the only action colour: primary buttons, the 2px focus ring, today markers. Hairlines do all separating: `--lx-border-default` `#26333D` / `#D5CFC1`, `--lx-border-subtle` `#1B242C` / `#E4DED1`, `--lx-border-strong` `#3E505D` / `#A9A192`. The brand plate is the one colour outside the world: the LX monogram (`docs/brand/lexa-mark.svg`, inlined through `--lx-brand-plate` / `--lx-brand-ink`). Spacing 4/8/12/16/24. Rows 36px desktop / 44px touch. Panels flat (1px border, no shadow); only overlays lift. Motion marks state only. ENERGY 2 / RHYTHM 2 / MOTION 1 stand unchanged.

**STORY.** The shell is the map's frame, not furniture: one head band you can rest your eye on, one navigation column, one working lane. When a surface needs a second column (threads, page tree) it joins the left system instead of standing beside it, so the frame never doubles.

## Before (measured 2026-10-11 — the deltas in the acceptance table are against these numbers)

| # | Measured fact | Source |
|---|---|---|
| B1 | Rail head band 40px (8px pad + 32px min-height) vs top bar 48px; rail `border-right` and top bar `border-bottom` cross at (200, 48). | AppShell.tsx / phosphor.css:9265-9291, 9423-9434; 1568 render |
| B2 | Collapsed rail (48px): collapse toggle plate measures 41×33px with only 7–8px to each rail edge — the tightest control on screen; the brand mark sits 9px below the toggle (head is column-stacked when collapsed). | owner crops `…443712ad18ffea9278a68aa552cf50a6.png`, `…9e644e3d1ba4af88e7d5f49278f45b74c.png`; phosphor.css:9296-9298 |
| B3 | In a 1461px-tall crop the last nav icon ends at y≈1055 — ≈28% of the rail is empty below it, with the only rail control crammed at the top. | owner crop (same) |
| B4 | Chat at 1568×900: `.chat-shell` starts at x=460 → rail 200px + threads pane 260px = 460px of left system before content; the chat body card is 760px floating in a 1108px area. | `.tmp/design/shots/u-chat-1568.png`; phosphor.css:6526-6528 |
| B5 | Wiki at 1568×900: `.wiki-content` starts at x=460 → page tree 200..460 = 260px, identical to the chat pane. Rail + pane = 460px before content. | agent-browser measurement; phosphor.css:2629-2643 |
| B6 | Owner's chat crop (467px wide): rail 12% / thread column 53.5% / body 34.5%. `+ New chat` 196×30 sits at a 19px left inset with a 20×24 icon button 7px away; search 220×30, 10px below; the empty state sits 44px below search with 203px of column below it. Column content 196–220px against 19px left / 9px right padding (asymmetric). Right panel content ≈7% of the panel, ≈93% blank. | owner crops `…b98a2cd686f13d5d57e9a273bf769a0d.png`, `…a3cec09037097772876a48fda7158e06.png` |
| B7 | Gaps in play across the shell: 7 / 9 / 10 / 13 / 15 / 19 / 20 / 44px side by side — none of it on the 4/8/12/16/24 scale. Type is flat (14–16px titles against 13px body). Everything is top-left anchored; insets lopsided (19–24px left vs 7–16px right). | owner crops (both) |
| B8 | Mid band 768–1023.98 renders **two** nav affordances: the hamburger + slide menu (phosphor.css:8251-8259) and the 168px rail with labelled links (phosphor.css:10137-10147; the later rule wins for links, so both are visible). | phosphor.css |
| B9 | Phone drawers pin `top: 48px` literal (phosphor.css:7237, 7720) while the phone band is 52px — a 4px sliver of pane shows under the top bar. | phosphor.css |
| B10 | The pane's collapsed stub is a third narrow band (36px threads stub, 36px `wiki-sidebar-rail`), and the pane head carries a 20×24 collapse icon 7px from `New chat` while the top bar carries a second toggle (`nav-sidebar-toggle`, only rendered ≤1023.98). | phosphor.css:7228-7233, 2645-2650; AppShell.tsx:100-116 |

## Shell anatomy (numbers are the contract)

### The cap band (one band across the window)

- **Height 48px** everywhere except phones where it is **52px**. Tokens: `layout.shell-band-h: 48px`, `layout.shell-band-h-phone: 52px`.
- The band spans the **full window width** (x = 0 … viewport). Background `--lx-surface-rail` across the whole band, both themes. Its **bottom hairline is 1px `--lx-border-default` running the full window width**.
- **Left cell = the brand cell**, width = the rail width (200px open / 48px collapsed / 168px mid band). It holds the brand and nothing else:
  - LX mark 24×24 (`--lx-brand-plate` ground, `--lx-brand-ink` strokes, `docs/brand/lexa-mark.svg` shapes) + wordmark `Lexa` in signage-brand (Space Grotesk 14px / 700 / +0.14em / uppercase) at open widths.
  - The brand row is 36px tall, padding 0 8px, 6px plate radius, centred on the band's midline (y = 24); hover fills `--lx-surface-card-hover` only.
  - **Collapsed (48px):** the mark alone, centred, **12px clearance to each rail edge** (24 + 12 + 12 = 48). The wordmark leaves the layout but stays in the link's accessible name.
  - No second control ever enters the brand cell — the collapse control is the rail's foot row (below). This is what kills B2/B3's cramped head.
- **Right segment = the top-bar row**, starting at x = rail width + 24px (16px tablet, 12px phone — the chrome gutter, unchanged), ending at window − 24px. Contents in order:
  1. **Pane toggle** (chat and wiki only): ghost control, 36px height, PanelLeft icon + signage-nav label `Threads` / `Pages`, `aria-expanded` + `aria-controls` the pane. Below 768px the label drops and the target grows to 44px (the wiki-settings-button precedent).
  2. **Title**: view name in signage-title (13px / 600 / +0.07em / uppercase) + project slug in surveyor-key (11px / 500 / +0.02em, muted ink).
  3. Flex spacer.
  4. **Chrome pills**: project switcher, theme toggle, user keycap — 36px pills (44px phone), `--lx-row-h` height, 12px horizontal padding. No primary action in the band (the standing no-primary-action rule).
- **The seam rule (T-junction).** The rail's right hairline (1px `--lx-border-default`) starts **below** the cap band and runs to the viewport bottom. There is **no vertical hairline inside the band**. The two hairlines meet in a T at (rail width, 48px) and never cross. The result reads as one frame in both themes: one horizontal rule under one continuous rail-toned head.
- **DOM / focus order.** The band is one header-level region: brand cell, then top-bar row; the rail body follows below it. Tab order: brand link → top-bar controls (pane toggle, switcher, theme, user) → rail nav links → rail foot control → surface pane → content. Keyboard order matches the visual order of the band, then the left system, then the lane.

### The rail body (navigation, and nothing else)

- Width **200px** open, **48px** collapsed, **168px** in the mid band (768–1023.98px). Background `--lx-surface-rail`, padding 8px, column gap 4px.
- **Nav links** — unchanged model: `Dashboard`, `Board`, `Tasks`, `Milestones`, `Swimlanes`, `Wiki`, and `Chat` when the assistant is enabled. Rows **36px** (`row-h`), gap **4px** (`space-1`), icon 16px, label signage-nav (12px / 600 / +0.06em / uppercase), full width inside the 8px padding (x = 8…192 at 200px). Rest secondary ink on transparent; hover `--lx-surface-card-hover` + primary ink; active `--lx-surface-card-active` + 1px `--lx-border-strong`; pressed `--lx-surface-card-active`. Transition background/color 120ms linear.
- **Foot control** — the rail's collapse toggle is the last row of the rail at every desktop width: 36px row, 1px `--lx-border-default`, 6px plate radius, PanelLeftClose / PanelLeft icon 16px, signage-nav label `Collapse` / `Expand` when open. Pinned to the rail's bottom (8px from the bottom edge, above `env(safe-area-inset-bottom)`).
  - **Collapsed (48px):** a 40px-wide, 36px-tall icon plate, 4px side inset; the 16px glyph is centred, so **resting ink sits ≥12px from both rail edges**. Hit plate may reach 4px from the edge; visible ink may not (fixes B2).
  - Labels leave the layout when collapsed but stay in the accessible name (`Collapse navigation` / `Expand navigation`).
- **Long nav:** the links group is the rail's only scroll region (`overflow-y: auto`); the brand cell and the foot control never move. Link labels are single-line with ellipsis; the full label stays in `title` and the accessible name. Rows never shrink below 36px (44px on touch widths).
- The rail carries no account cluster and no other control (standing rule).

### The surface pane — chat threads / wiki page tree (the no-double-sidebar rule)

**One Left System Rule.** On chat and wiki the rail and the surface pane form **one continuous rail-toned left system** below the cap band. Ground `--lx-surface-elevated` (= rail tone). The divider **between** nav group and pane is 1px `--lx-border-subtle`; the **outer** edge of the whole left system (pane → content) is 1px `--lx-border-default`, and it is the only default hairline down the left side. On dashboard/board/tasks/milestones/swimlanes there is no pane and the rail's outer edge keeps that same hairline at x = rail width. One system, one strong edge.

- **Docked** at ≥1024px: pane width **280px** at ≥1440px, **260px** at 1024–1439px. The pane's right edge is the left system's outer hairline.
- **Drawer** below 1024px (tablet 768–1023.98 and phone ≤767.98): **288px** wide, fixed under the cap band (`top: 48px`, or `52px` on phones — read it from the band token, never a literal that drifts, fixing B9), full height to the viewport bottom, over the `--lx-surface-overlay` scrim. Escape, scrim tap, or the toggle closes it; body scroll is locked while open.
- **No 36px collapsed stub** (B10). The pane is docked or absent (drawer below 1024). Open/close is owned by one control: the top bar's labelled `Threads` / `Pages` toggle. The pane's internal `Collapse sidebar` button is deleted.
- **Pane interior shares the rail's row geometry** (this is what makes it a group of the rail, not a second sidebar):
  - Side insets **8px left and right, symmetric** (fixes B6's 19/9 lopsidedness); gaps **4px**; every gap is a step of 4/8/12/16/24 (fixes B7's 7/9/10/13/15/19/20).
  - **Head row 36px:** signage-plate label `THREADS` / `PAGES` (11px / 600 / +0.07em / uppercase, secondary ink) with the item count right-aligned in surveyor-micro (10px tabular, muted ink).
  - **Control rows 36px** (44px ≤767.98): chat = `New chat` ghost button (full inner width, + icon, guide-body 13px) then the search field (36px height, `--lx-surface-input` ground, 1px `--lx-border-input`, 6px radius, focus `--lx-border-focus`); wiki = the search field, then `New page` ghost button where the surface already offers one.
  - **Rows 36px** (44px touch): thread rows and tree rows, 6px plate radius, hover `--lx-surface-card-hover`, active `--lx-surface-card-active` + strong border. Titles single-line ellipsis; thread meta in surveyor-micro. Tree indent 16px per level (existing `tree-item` primitive). The list is the pane's only scroll region.
- **State persistence:** per surface, `localStorage["lexa:pane-threads"]` and `localStorage["lexa:pane-wiki"]` (`"open"` / `"closed"`), beside the existing `lexa:rail-open`. Default: open.

### The content lane (use the width, keep the measure)

**The Reading-Measure Rule.** Readable text caps at **75ch** (`layout.measure-body: 75ch`) — wiki prose and chat message text. Code blocks, diffs, tables and the profile panorama may span their column. The slack beside a measure is symmetric designed air (within ±8px left/right) and the measure never stretches to fill it. Wide artifacts are what earn the desktop width.

- **Chat** (`/…/chat`): transcript column **860px** at ≥1440px (`layout.transcript-w`), **760px** at 1024–1439px, full width below 1024; centred in the content lane. The thread header row (thread title + meta + pin/edit/delete icon buttons) and the composer both span the **column**, never the window (fixes B6's far-right icon cluster and 275px empty header). Message text ≤75ch (≈540px at 13px guide); code, diffs and approval cards span the 860px. Void plates centre in the column at the column's width.
- **Wiki** (`/…/wiki`): the read area keeps its padding (32px 48px desktop, 20px phone). The page masthead (page title, meta, actions) spans the read area's inner width; the prose caps at **75ch** (≈620px at the 15px wiki measure), centred in the lane left after the outline reserve (236px at 768–1479.98px while the outline pill exists — the frozen OutlinePill/Panel primitive, unchanged). The page tree is the pane (above).
- **Page-frame surfaces** (dashboard, board, tasks, milestones, swimlanes, settings): unchanged — `page-frame` padding 10px 24px 16px desktop / 24px 16px tablet / 14px 12px phone, `page-frame-narrow` caps bodies at `--lx-content-max` 1200px. The dashboard's six-region contract is untouched.
- **Full-height regions** (`.chat-layout`, `.wiki-layout`) read `calc(100dvh - var(--lx-shell-band-h))` (52px phone) — no literal 48px, no double scrollbars, no 4px sliver.

### Geometry by width (transcribe as-is)

| Region | ≥1440px | 1024–1439px | 768–1023.98px | ≤767.98px (390 tested) |
|---|---|---|---|---|
| Cap band | 48px | 48px | 48px | 52px |
| Brand cell / rail | 200px open, 48px collapsed | 200 / 48 | 168 / 48 | none — labelled `Menu` |
| Surface pane (chat/wiki) | 280px docked | 260px docked | 288px drawer + scrim | 288px drawer + scrim |
| Chrome gutter | 24px | 24px | 16px | 12px |
| Chat transcript column | 860px | 760px | full lane | full lane |
| Wiki prose measure | 75ch | 75ch | 75ch | full width, 15px/24px |
| Rows (nav, pane) | 36px | 36px | 36px | 44px |
| Pane/toggle targets | 36px | 36px | 36px | 44px |

## First viewport (what occupies what, in proportions)

**Chat, 1568×900, threads docked (280px).** Cap band 1568×48 = 5.3% of height. Left system 480px = 30.6% of width (nav 200 = 12.8%, threads 280 = 17.8%). Content lane 1088 = 69.4%: transcript column 860 = 54.9% of the window, centred, leaving **114px (7.3%) symmetric ground on each side**. Vertically: thread head 36 + controls 36 + rows; chat header 64px inside the column; transcript fills the rest; composer ≈120px pinned to the lane's bottom inside the column. Empty: the two symmetric air strips and the rail's scroll region between the links group and the foot control — nothing else.

**Chat, 1440×900, threads docked (280px).** Left system 480 = 33.3%; content lane 960 = 66.7%; transcript 860 = 59.7%; air 50px (3.5%) each side.

**Chat, threads closed (1568×900).** The lane widens to 1368 = 87.2%; the transcript column **stays 860px** and re-centres (air 254px each side, symmetric). The measure never widens to fill — the pane's width goes to air, not to longer lines.

**Wiki, 1568×900, tree docked (280px).** Left system 480 = 30.6%. Content lane 1088 = 69.4%; read-area inner width 992 (48px padding each side); masthead spans 992 = 63.3%; prose 75ch ≈ 620px = 39.5% of the window, centred in the 756px lane left after the 236px outline reserve → **≈68px (4.3%) air each side**. Without an outline on the page the prose centres in 992 → 186px (11.9%) air each side, symmetric.

**Wiki, 1440×900, tree docked (280px).** Left system 480 = 33.3%; read-area inner 864; outline reserve 236 → prose lane 628; prose min(75ch, lane) = 620 → ≈4px air each side; without the outline, 122px (8.5%) each side.

**Wiki, tree closed (1568×900).** Lane 1368; read-area inner 1272; prose 75ch ≈ 620 centred (with the outline reserve, lane 1036 → 208px air each side). Same rule: the freed pane width becomes symmetric air and masthead width, never wider body lines.

**Phone 390×844.** Cap band 52px (6.2% of height): `Menu` control (44px, icon + label) left, pane toggle icon-only 44px on chat/wiki, title 12px + slug, theme + user 44px pills right; the project switcher lives in the menu panel. Below: full-width lane; on chat/wiki the pane opens as the 288px drawer over the scrim (102px of scrim visible). Zero horizontal overflow. `env(safe-area-inset-bottom)` respected by the composer and the menu.

**Tablet 768–1023.98.** Rail 168px with labelled 36px links (labels fit: `MILESTONES` at signage-nav ≈ 90px + 16px icon + 10px gap + 20px padding = 136px < 168px). **Exactly one nav affordance** — the hamburger and the slide-down menu are phone-only (fixes B8). Pane = 288px drawer. Chrome gutter 16px.

## States matrix

| Component | States |
|---|---|
| Rail (open) | 200px; brand cell = mark + `Lexa`; 7 labelled links; foot `Collapse` row pinned bottom. |
| Rail (collapsed) | 48px; mark only (12px side clearance); icon plates 40×36 with glyphs ≥12px from both edges; labels hidden visually, present in accessible names; foot `Expand` icon plate pinned bottom. Transition 120ms linear on width; instant under reduced motion. |
| Nav link | default (secondary ink, transparent) · hover (`--lx-surface-card-hover`, primary ink) · focus-visible (global 2px patrol-orange ring, 2px offset) · active (`--lx-surface-card-active` + 1px strong border) · pressed (card-active) · disabled: none (every link is always reachable; with no project selected links target the projects list `/`). |
| Foot collapse control | default / hover / focus-visible / active as nav link; aria-expanded on the rail; label flips `Collapse` / `Expand`. |
| Pane toggle (top bar) | hidden on non-chat/wiki routes · visible labelled ≥768px · icon-only 44px ≤767.98px · `aria-expanded` + `aria-controls` · active state fills `--lx-surface-card-active`. |
| Surface pane — docked | 280px (≥1440) / 260px (1024–1439); subtle inner divider; default outer hairline; head 36px + controls 36px + scrolling rows. |
| Surface pane — drawer (≤1023.98) | 288px, top = band height (48/52), scrim `--lx-surface-overlay`, Escape + scrim + toggle close, body scroll locked, 44px rows on phone. |
| Surface pane — closed | no stub band; content lane takes the width; toggle reopens. |
| Pane rows (thread / tree) | default · hover (card-hover) · focus-visible (global ring) · active (card-active + strong border) · loading (30px skeleton blocks in `--lx-surface-card-hover`, 4px radius) · empty (chat: `No threads yet — start a conversation`; wiki: `No pages yet` with `New page`) · search-no-match (`No threads match` / `No pages match` + `Clear search`) · error (danger void: `Threads could not be read.` / `Pages could not be read.` + `Retry`) · long content (internal scroll, titles ellipsis, tree indent 16px/level). |
| Phone menu (≤767.98) | labelled `Menu` control (44px) opens the full-height panel below the 52px band; panel head = brand row (mark + `Lexa`, 48px) then the project switcher block; links 44px rows in large-plate caps; scrim + Escape close; closes on route change (existing behavior). |
| Long nav | links group scrolls; brand cell and foot control stay put; labels ellipsize with full name in `title` + accessible name. |
| Cap band | one band at every width; brand cell empty of controls; T-junction hairlines; on phone the brand lives in the menu panel head, not the band. |

## Tokens and primitives

**Tokens used (all from `DESIGN.md`; the `layout:` block below is added there with these values):**
`--lx-surface-rail` · `--lx-surface-elevated` (= rail tone) · `--lx-surface-ground` · `--lx-surface-card-hover` · `--lx-surface-card-active` · `--lx-surface-input` · `--lx-surface-overlay` · `--lx-border-default` · `--lx-border-subtle` · `--lx-border-strong` · `--lx-border-input` · `--lx-border-focus` · `--lx-text-primary` · `--lx-text-secondary` · `--lx-text-muted` · `--lx-brand-plate` / `--lx-brand-ink` · `--lx-row-h` 36px · `--lx-row-h-touch` 44px · `--lx-space-1..6` (4/8/12/16/24) · `--lx-radius-plate` 6px · `--lx-radius-micro` 4px · `--lx-focus-ring` · `--lx-content-max` 1200px (page frames only).

New layout tokens (normative in `DESIGN.md` frontmatter `layout:`): `shell-band-h: 48px` · `shell-band-h-phone: 52px` · `rail-w: 200px` · `rail-w-mid: 168px` · `rail-w-collapsed: 48px` · `pane-w: 260px` · `pane-w-wide: 280px` · `pane-drawer-w: 288px` · `transcript-w: 860px` · `measure-body: 75ch`. No raw hex outside `app/styles/phosphor.css` (standing rule).

**Type roles used:** signage-brand (wordmark) · signage-title (top-bar view name) · signage-nav (rail links, rail controls, pane toggle label) · signage-plate (pane head labels) · signage-plate-lg (mobile menu links) · guide-body (button labels, void copy) · guide-sub (meta) · surveyor-key (slug) · surveyor-micro (pane counts, thread meta).

**Primitives (copy markup from `docs/design-system.html`, never hand-write):** ghost button + `btn-sm` (pane actions, `New chat`) · inputs block (pane search) · icon button 32px desktop / 44px touch (header actions) · `nav-pill` / `nav-pill-icon` (top-bar chrome pills, row-height variant as today) · keycap (user) · `tree-item` (wiki tree rows) · OutlinePill + OutlinePanel (wiki outline — frozen, unchanged) · void plate + skeletons (pane and lane void states) · prose blocks `.wiki-prose` / `.bubble-md` (measures above).

## Motion (MOTION 1 — state only)

| Trigger | Change | Timing |
|---|---|---|
| Rail collapse / expand | width 200↔48 (168↔48 mid band) | 120ms linear |
| Pane dock / close | lane reflow, no fade | 120ms linear |
| Pane drawer open / close (≤1023.98) | translateX(±100% → 0) + scrim | 180ms linear (scrim 120ms) |
| Nav/pane row hover, active | background + color | 120ms linear (existing) |
| Everything else | no motion; no loops, no ambient | — |

Reduced motion: every transition snaps to final state (`transition: none` under `prefers-reduced-motion: reduce`).

## Accessibility

- Contrast: nav labels secondary ink `#9FB2BE` on rail `#0B1014` ≈ 8:1; primary ink on card-active ≥ 7:1; muted ink only for meta (≥4.5:1 both themes). Verified in both themes.
- Focus: global ring `--lx-focus-ring` (2px patrol-orange, 2px offset) on every control; no focus shadows.
- Order: brand → top-bar controls → rail links → foot control → pane → content (see cap band). The content region is a labelled `main`.
- Labels: collapsed rail labels stay in accessible names; pane toggle carries `aria-expanded` + `aria-controls` and its surface name (`Threads` / `Pages`); the phone `Menu` button carries `aria-expanded`; drawers trap nothing but close on Escape and return focus to their toggle.
- Targets: 32px minimum on desktop, 44px on touch (phone menu, drawer rows, phone pills). Resting ink of collapsed-rail glyphs ≥12px from rail edges (hit plates may reach 4px).
- Names exact: `Dashboard`, `Board`, `Tasks`, `Milestones`, `Swimlanes`, `Wiki`, `Chat`, `Menu`, `Threads`, `Pages`, `Collapse`, `Expand`, `New chat`, `Search threads…`, `Project`, `Project settings`, `Create new project`, `Theme`.

## Copy (user-facing strings this surface adds or keeps)

`Lexa` (wordmark) · `Menu` · `Threads` · `Pages` · `Collapse` / `Expand` · `New chat` · `Search threads…` · `No threads yet — start a conversation` · `No threads match` · `Clear search` · `Threads could not be read.` · `Retry` · `New page` · `No pages yet` · `No pages match` · `Pages could not be read.` · `Project` · `Project settings` · `Create new project` · top-bar view names and slugs unchanged.

## Acceptance checks (measurable — deltas against the Before table)

1. **Band = one band.** At 1568×900 and 390px wide the cap band measures exactly 48px (52px phone) across the full window; its bottom hairline spans x=0…viewport; the rail's right hairline starts at y=48 (y=52 phone). The hairlines meet in a **T** at (rail width, band height) in night and day themes — no crossing at (200, 48) (kills B1).
2. **Brand cell purity.** The brand cell contains exactly one focusable element (the brand link) at every width. Collapsed: mark 24px with 12px clearance both sides. No control sits above the brand (kills B2's 9px stack).
3. **Collapsed-rail ink clearance.** In the 48px rail every resting glyph and the brand mark sit ≥12px from both rail edges (measurement: bounding box of visible ink, not the hit plate) (kills B2's 7–8px).
4. **Foot control.** The collapse control's bottom edge is 8px above the rail's bottom at 1440×900 and at 1461px-tall windows; it is the rail's last row in open and collapsed states (kills B3's crammed head; the rail's mid-column air is the single allowed empty span in the left system).
5. **One left system.** At 1568×900 on chat and on wiki exactly one 1px `--lx-border-default` hairline runs the full height of the left system at its outer edge (x = 480 with the pane open, x = 200 with it closed); the rail↔pane divider is 1px `--lx-border-subtle`. Screenshot geometry, both themes (kills B4/B5's double-sidebar read).
6. **Pane widths.** Threads and page tree measure 280px at 1568, 260px at 1280, 288px as a drawer at 768 and 390; the drawer's top equals the band height (52px at 390 — no 48px literal anywhere, kills B9).
7. **No stub band.** No 36px collapsed pane exists; the only pane widths in the layout are 260/280/0 (dock) and 288 (drawer) (kills B10).
8. **Scale discipline.** Every gap and inset in the shell and panes is one of 4/8/12/16/24px; pane side insets are symmetric (8px = 8px) at 260 and 280px (kills B6/B7). Verified by reading computed styles of `.app-nav`, `.app-topbar-inner`, pane head/controls/rows.
9. **Pane head + controls density.** `New chat` spans the pane's inner width (pane width − 16px); the search field matches; the former 20×24 collapse icon is gone; the pane head row is 36px with `THREADS` / `PAGES` + count (kills B6's 196×30 at 19px inset with a 20×24 neighbour).
10. **Measure.** Wiki prose and chat message text compute `max-width` ≤ 75ch; code/diff/table blocks inside chat reach the full 860px (≥1440) / 760px (1024–1439) column; the air beside the measure is symmetric within ±8px at 1568 and 1440 (chat pane open and closed, wiki tree open and closed).
11. **First viewport.** Chat at 1568×900: left system 30.6% ±1%, transcript column 54.9% ±1%, per-side air 7.3% ±1%. Wiki at 1568×900: left system 30.6% ±1%, prose ≈39.5% of window width, masthead spans the 992px read-area inner width. Chat at 1440×900: left system 33.3% ±1%, transcript 59.7% ±1%.
12. **One nav affordance per band.** At 768–1023.98px the rail (168px, labelled links) is the only navigation: `.nav-hamburger` and `.app-nav-menu` compute `display: none` in that range (kills B8). At ≤767.98px the rail is gone and the labelled `Menu` control is the only navigation entry.
13. **Heights.** `.chat-layout` and `.wiki-layout` compute `calc(100dvh - <band>)` (48 desktop / 52 phone); one scroll container per surface; no horizontal overflow at 390, 768, 1440, 1568.
14. **Focus order + labels.** One Tab pass at 1568 reaches: brand → pane toggle → switcher → theme → user → 7 nav links → `Collapse` → pane controls → content, in that order. axe reports no name/aria violations on the shell.
15. **Tokens only.** Changed CSS introduces no raw hex; every geometry value resolves from the `layout:` tokens added to `DESIGN.md` frontmatter; nav/pane colors resolve from the existing PHOSPHOR variables in both themes.
16. **Dashboard contract intact.** `/…/dashboard` still renders the six regions in contract order inside 1440×900 with the shell measured as above; `page-frame`, `page-frame-narrow`, and `--lx-content-max` behavior unchanged.
17. **Reduced motion.** With `prefers-reduced-motion: reduce`, rail collapse and pane transitions are `transition: none`; drawer appears without translate animation.

## FINISH

unreviewed and undocumented is unfinished; this build ends with the browser check at 390 / 768 / 1440 / 1568 in both themes, the acceptance table above with measured values pasted beside each check, and no deviation from these numbers without a design pass back to `.impeccable/surfaces/shell-rail.md`.
