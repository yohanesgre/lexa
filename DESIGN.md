---
name: Lexa
description: "Self-hosted project tracker drawn as one surveyed mountain: a floodlit night map by default, a printed day map on switch, trail-signage type, and difficulty ribbons that carry priority and nothing else."
colors:
  # Map furniture: ground (app field) / band + rail (chrome: the cap band, the nav rail and the
  # surface panes) / panel (cards) / column (board columns, profile fill). The warm day map lays
  # off-white plates (#FFFDF9) on a ground of that same card tone, sinks the chrome to one warm
  # tone (#F7F3EA), and keeps warm ink in the type: the day map is the night map at the other
  # time of day, never an inversion.
  ground-night: "#10161B"
  ground-day: "#FFFDF9"
  rail-night: "#0B1014"
  rail-day: "#F7F3EA"
  # The cap band: the rail tone at night, its own (lighter) tone on the day map.
  band-night: "#0B1014"
  band-day: "#F7F3EA"
  # Chrome rows (rail links, pane rows) step against the chrome itself, where the content's subtle
  # hover would vanish on the light chrome.
  chrome-hover-night: "#1F2C36"
  chrome-hover-day: "#E6DECD"
  chrome-active-night: "#26343F"
  chrome-active-day: "#DCD3BE"
  panel-night: "#18222B"
  panel-day: "#FFFDF9"
  column-night: "#141C24"
  column-day: "#F9F6EF"
  card-hover-night: "#1F2C36"
  card-hover-day: "#F1ECE0"
  card-active-night: "#26343F"
  card-active-day: "#E6DFCE"
  card-dragging-night: "#1F2C36"
  card-dragging-day: "#FFFDF9"
  input-night: "#0D141A"
  input-day: "#FFFDF9"
  overlay-night: "rgba(8, 12, 16, 0.78)"
  overlay-day: "rgba(42, 36, 27, 0.42)"
  tooltip-night: "#22303B"
  tooltip-day: "#2A241B"
  selected-night: "rgba(240, 192, 64, 0.12)"
  selected-day: "rgba(212, 160, 23, 0.14)"
  # Borders — two line weights on the day map: the pencil hairline (border, border-subtle,
  # separators) and the inked line (border-strong, border-input, both #5E5343: state marks
  # and field boundaries clear 3:1 on every day surface and state fill).
  border-night: "#26333D"
  border-day: "#C2B79E"
  border-subtle-night: "#1B242C"
  border-subtle-day: "#CFC4AC"
  border-strong-night: "#3E505D"
  border-strong-day: "#5E5343"
  border-focus-night: "#F0C040"
  border-focus-day: "#7E5C00"
  border-input-night: "#43565F"
  border-input-day: "#5E5343"
  border-input-hover-night: "#5A6E78"
  border-input-hover-day: "#443C30"
  # Ink — the day ramp is warm: secondary and muted are pulled darker so every ink of the ramp
  # clears 4.5:1 on the state fills (the pressed step is the binding host).
  ink-night: "#EAF2F6"
  ink-day: "#2A241B"
  ink-secondary-night: "#9FB2BE"
  ink-secondary-day: "#544B3C"
  ink-tertiary-night: "#8DA0AC"
  ink-tertiary-day: "#635A49"
  ink-muted-night: "#7E929F"
  ink-muted-day: "#615846"
  ink-inverse-night: "#0B1014"
  ink-inverse-day: "#FDFBF7"
  ink-danger-night: "#FF9C8F"
  ink-danger-day: "#8E2018"
  ink-warning-night: "#E8A33D"
  ink-warning-day: "#7A4E0C"
  ink-success-night: "#8FD9A8"
  ink-success-day: "#14572B"
  link-night: "#F0C040"
  link-day: "#7E5C00"
  link-hover-night: "#F5D76A"
  link-hover-day: "#6B4E00"
  # Brand amber (the accent): primary action, focus ring, today marker, "You are here". The hue
  # splits at the paper line. Night: one value (#F0C040) carries fill, ring, marks, and links.
  # Day: the primary action is the deep amber (#8A5A0A) carrying a light label (#FFF9EC); the
  # plate yellow (#D4A017) cannot hold a light label — 2.27:1. Everything drawn on the sheet
  # (ring, marker strokes, links) keeps the ink amber, because plate yellow on the warm stock is
  # 1.60 to 2.34:1 and cannot mark anything or define its own edge — the day primary button
  # carries its 1px ink-amber rim on every surface. border-focus-day and link-day are that ink
  # amber; brand-amber-muted-day holds the same value because the day chrome leaves no lighter
  # step that still clears 4.5:1. One named miss: ink-amber marks on the pressed chrome step
  # read 4.13:1; see Colors for the nearest passing value and its cost.
  brand-amber-night: "#F0C040"
  brand-amber-day: "#8A5A0A"
  brand-amber-hover-night: "#F5D76A"
  brand-amber-hover-day: "#93600C"
  brand-amber-ink-night: "#10161B"
  brand-amber-ink-day: "#FFF9EC"
  brand-amber-muted-night: "#C99B3C"
  brand-amber-muted-day: "#7E5C00"
  # The LX brand plate and its ink — the one colour in the app that is not from the Trail Map
  # palette: identity is the brand's job, so the mark ships its own plate (the deeper day plate
  # on the light theme, as the favicon does) and its own dark ink.
  brand-plate-night: "#F0C040"
  brand-plate-day: "#D4A017"
  brand-ink: "#0C0B09"
  # Tinted state grounds
  danger-subtle-night: "rgba(210, 55, 47, 0.14)"
  danger-subtle-day: "rgba(176, 42, 34, 0.10)"
  warning-subtle-night: "rgba(232, 163, 61, 0.14)"
  warning-subtle-day: "rgba(154, 100, 16, 0.12)"
  success-subtle-night: "rgba(46, 158, 79, 0.14)"
  success-subtle-day: "rgba(31, 122, 58, 0.10)"
  accent-subtle-night: "rgba(240, 192, 64, 0.14)"
  accent-subtle-day: "rgba(212, 160, 23, 0.10)"
  # Chip tints (badge and priority-band text): darker values on the light theme so the tinted
  # ground keeps its contrast.
  badge-feature-night: "#8FD9A8"
  badge-feature-day: "#14572B"
  badge-bug-night: "#FF9C8F"
  badge-bug-day: "#8E2018"
  badge-task-night: "#7FD8E4"
  badge-task-day: "#155E6B"
  badge-asset-night: "#F0A6D0"
  badge-asset-day: "#8E1B52"
  pb-medium-night: "#7FD8E4"
  pb-medium-day: "#155E6B"
  pb-low-night: "#9FB2BE"
  pb-low-day: "#5A6B76"
  # Scrollbars (promoted from the ported leftovers into the record with the day redesign):
  # CSS variables --lx-scrollbar-track / --lx-scrollbar-thumb / --lx-scrollbar-thumb-hover.
  scrollbar-track-night: "ground-night (alias — --lx-scrollbar-track: var(--lx-surface-ground))"
  scrollbar-track-day: "ground-day (alias — --lx-scrollbar-track: var(--lx-surface-ground))"
  scrollbar-thumb-night: "#26333D"
  scrollbar-thumb-day: "#857B6B"
  scrollbar-thumb-hover-night: "#3E505D"
  scrollbar-thumb-hover-day: "#6E6555"
  # Difficulty ribbons: priority encoding. Fills are identical at both times of day.
  run-lowest: "#1F7A3A"
  run-normal: "#2F74D0"
  run-high: "#D2372F"
  run-highest: "#0B0B0C"
  run-lowest-ink: "#FFFFFF"
  run-normal-ink: "#FFFFFF"
  run-high-ink: "#FFFFFF"
  run-highest-ink: "#FFFFFF"
  run-rim-night: "rgba(255, 255, 255, 0.34)"
  run-rim-day: "rgba(11, 11, 12, 0.55)"
  # Lift-line hues: per-project and data series only
  series-glacier: "#35B7C8"
  series-gold: "#E8A33D"
  series-plum: "#9A5BD0"
  series-meadow: "#2E9E4F"
  series-slate: "#7E929F"
  # Stamp ink: sync, approval, revision
  stamp-sync-night: "#8FBCF5"
  stamp-sync-day: "#1F5FA8"
  stamp-fail-night: "#FF9C8F"
  stamp-fail-day: "#8E2018"
  stamp-bg-night: "rgba(47, 116, 208, 0.14)"
  stamp-bg-day: "rgba(47, 116, 208, 0.12)"
  stamp-bg-fail-night: "rgba(210, 55, 47, 0.16)"
  stamp-bg-fail-day: "rgba(176, 42, 34, 0.12)"
  # State hues: meaning only (WIP near or over limit, sync degraded or failed, overdue)
  status-danger-night: "#D2372F"
  status-danger-day: "#B02A22"
  status-warning-night: "#E8A33D"
  status-warning-day: "#9A6410"
  status-success-night: "#2E9E4F"
  status-success-day: "#1F7A3A"
  status-info-night: "#35B7C8"
  status-info-day: "#1D7C88"
typography:
  signage:
    fontFamily: "Space Grotesk, -apple-system, BlinkMacSystemFont, sans-serif"
  guide:
    fontFamily: "IBM Plex Sans, -apple-system, BlinkMacSystemFont, sans-serif"
  surveyor:
    fontFamily: "JetBrains Mono, SF Mono, Fira Code, monospace"
  signage-brand:
    fontFamily: "Space Grotesk, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "14px"
    fontWeight: 700
    lineHeight: "1"
    letterSpacing: "0.14em"
  signage-title:
    fontFamily: "Space Grotesk, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: "1"
    letterSpacing: "0.07em"
  signage-plate-lg:
    fontFamily: "Space Grotesk, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: "1"
    letterSpacing: "0.06em"
  signage-plate:
    fontFamily: "Space Grotesk, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: "1"
    letterSpacing: "0.07em"
  signage-nav:
    fontFamily: "Space Grotesk, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: "1"
    letterSpacing: "0.06em"
  guide-body:
    fontFamily: "IBM Plex Sans, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "17px"
    letterSpacing: "normal"
  guide-sub:
    fontFamily: "IBM Plex Sans, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: "15px"
    letterSpacing: "normal"
  surveyor-count:
    fontFamily: "JetBrains Mono, SF Mono, Fira Code, monospace"
    fontSize: "20px"
    fontWeight: 400
    lineHeight: "22px"
    letterSpacing: "normal"
    fontFeature: "tnum"
  surveyor-key:
    fontFamily: "JetBrains Mono, SF Mono, Fira Code, monospace"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: "1"
    letterSpacing: "0.02em"
    fontFeature: "tnum"
  surveyor-ribbon:
    fontFamily: "JetBrains Mono, SF Mono, Fira Code, monospace"
    fontSize: "11px"
    fontWeight: 700
    lineHeight: "1"
    letterSpacing: "normal"
    fontFeature: "tnum"
  surveyor-stamp:
    fontFamily: "JetBrains Mono, SF Mono, Fira Code, monospace"
    fontSize: "10px"
    fontWeight: 400
    lineHeight: "1"
    letterSpacing: "0.06em"
    fontFeature: "tnum"
  surveyor-micro:
    fontFamily: "JetBrains Mono, SF Mono, Fira Code, monospace"
    fontSize: "10px"
    fontWeight: 400
    lineHeight: "1"
    letterSpacing: "normal"
    fontFeature: "tnum"
rounded:
  micro: "4px"
  plate: "6px"
  ribbon: "8px"
  panel: "10px"
  pill: "9999px"
spacing:
  space-1: "4px"
  space-2: "8px"
  space-3: "12px"
  space-4: "16px"
  space-6: "24px"
  row-h: "36px"
  row-h-touch: "44px"
layout:
  # Shell geometry: the cap band, the rail, the surface pane, the reading measure.
  shell-band-h: "48px"
  shell-band-h-phone: "56px"
  rail-w: "200px"
  rail-w-mid: "168px"
  rail-w-collapsed: "48px"
  pane-w: "260px"
  pane-w-wide: "280px"
  pane-drawer-w: "288px"
  transcript-w: "860px"
  measure-body: "75ch"
components:
  signage-plate:
    textColor: "{colors.ink-secondary-night}"
    typography: "{typography.signage-plate}"
  signage-plate-lg:
    textColor: "{colors.ink-night}"
    typography: "{typography.signage-plate-lg}"
  section-panel:
    backgroundColor: "{colors.panel-night}"
    textColor: "{colors.ink-night}"
    rounded: "{rounded.panel}"
    padding: "8px"
  difficulty-ribbon:
    backgroundColor: "{colors.run-normal}"
    textColor: "{colors.run-normal-ink}"
    typography: "{typography.surveyor-ribbon}"
    rounded: "{rounded.ribbon}"
    width: "34px"
    height: "16px"
  difficulty-ribbon-lowest:
    backgroundColor: "{colors.run-lowest}"
    textColor: "{colors.run-lowest-ink}"
    rounded: "{rounded.ribbon}"
  difficulty-ribbon-high:
    backgroundColor: "{colors.run-high}"
    textColor: "{colors.run-high-ink}"
    rounded: "{rounded.ribbon}"
  difficulty-ribbon-highest:
    backgroundColor: "{colors.run-highest}"
    textColor: "{colors.run-highest-ink}"
    rounded: "{rounded.ribbon}"
  trail-stamp:
    backgroundColor: "{colors.stamp-bg-night}"
    textColor: "{colors.stamp-sync-night}"
    typography: "{typography.surveyor-stamp}"
    rounded: "{rounded.micro}"
    height: "20px"
    padding: "0 7px"
  trail-stamp-degraded:
    backgroundColor: "{colors.warning-subtle-night}"
    textColor: "{colors.ink-warning-night}"
    typography: "{typography.surveyor-stamp}"
    rounded: "{rounded.micro}"
  trail-stamp-failed:
    backgroundColor: "{colors.stamp-bg-fail-night}"
    textColor: "{colors.stamp-fail-night}"
    typography: "{typography.surveyor-stamp}"
    rounded: "{rounded.micro}"
  trail-row:
    height: "{spacing.row-h}"
    padding: "4px 10px"
    rounded: "{rounded.plate}"
  trail-row-hover:
    backgroundColor: "{colors.card-hover-night}"
    textColor: "{colors.ink-night}"
    rounded: "{rounded.plate}"
  void-plate:
    textColor: "{colors.ink-secondary-night}"
    typography: "{typography.guide-body}"
    rounded: "{rounded.plate}"
    padding: "16px"
  button-primary:
    backgroundColor: "{colors.border-focus-night}"
    textColor: "{colors.ink-inverse-night}"
    rounded: "{rounded.plate}"
    height: "36px"
    padding: "0 14px"
    typography: "{typography.guide-body}"
  button-primary-hover:
    backgroundColor: "{colors.link-hover-night}"
    textColor: "{colors.ink-inverse-night}"
  button-ghost-sm:
    textColor: "{colors.ink-secondary-night}"
    rounded: "{rounded.plate}"
    height: "32px"
    padding: "0 10px"
    typography: "{typography.guide-body}"
  nav-link:
    textColor: "{colors.ink-secondary-night}"
    typography: "{typography.signage-nav}"
    height: "{spacing.row-h}"
    padding: "0 10px"
    rounded: "{rounded.plate}"
  keycap:
    backgroundColor: "{colors.input-night}"
    textColor: "{colors.ink-secondary-night}"
    typography: "{typography.surveyor-micro}"
    rounded: "{rounded.micro}"
    height: "20px"
    padding: "0 6px"
---

# Design System: Lexa

## Overview

**Creative North Star: "The Tuned CRT"**

The North Star is carried as tuned, warm, human precision: instruments calibrated by hand until they read true. Its literal CRT reading — the amber-on-black HUD workspace this world replaced — is still refused as a *look*: no monochrome amber field, no glowing terminal furniture, no amber on everything. The amber itself was never the rut, and it returns on purpose: the brand's own LX-plate yellow is the map's one action colour, a single lit plate on a cold slate field. The world that expresses it is the Trail Map: the tracker reads as one surveyed mountain at two times of day. The default is the floodlit night map, a cold slate field with lit ribbons and crisp signage plates; the switch gives the printed day map, the same mountain at the other time of day — warm stock underfoot, off-white plates laid on it, warm ink in the type, and the amber the only saturated note, with the same ribbons and the same plates. The day map is a translation of the same mountain, never an inversion.

The world lends type, palette, density, and one signature move. It never supplies layout, navigation model, or controls: nav is nav, buttons are buttons, tables sort with standard headers. A working screen must read as a tracker of its category first. The voice is warm, playful, and tactile, and it lives in the display layers only. Every control and state keeps its plain name (`New task`, `Blocked`, `Needs attention`); metaphor display names sit beside plain truth (`Timeline`, with the plain sub-line `Milestones and sprint progress`). The ornament budget is spent entirely in the signature panel; lists and forms stay bare.

Density is the working loop. The dashboard holds six regions inside a 1440x900 viewport at status-report density, lists run at 36px rows on desktop and 44px on touch, and every count is a tabular figure. Panels sit flat on the ground; only overlays lift. Motion is a surveyed redraw, never ambient: lines draw once per mount and stop.

**Dial: ENERGY 2 / RHYTHM 2 / MOTION 1.** A working tool speaks clearly and stays quiet: signage plates label regions, brand amber marks the one live action, the six dashboard regions differ in shape (strip, panorama, meters, rows) without competing for the eye, and motion exists only to mark a state change.

**Key Characteristics:**
- One mountain, two times of day: floodlit night map by default, printed day map on switch, same furniture in both.
- Three type voices with strict jobs: Signage caps for plates and labels, Guide for all readable copy, Surveyor tabular figures for every number.
- Difficulty ribbons encode priority and nothing else, always doubled by their rank numeral and the configured priority name.
- Brand amber is the only action colour: primary buttons, focus ring, today marker, and the "You are here" post; at day the hue splits at the paper line into the plate-yellow fill and the ink-amber marks and links.
- Trail-report density: 36px desktop rows, 44px touch rows, 4px spacing scale, whole-cell repack.
- Hybrid elevation: flat bordered panels everywhere, one shadow layer reserved for lifted overlays.
- Motion draws once (180 to 260ms linear) and snaps to final state under reduced motion.

**The Plain-Name Rule.** Metaphor display names never replace a plain truth. Every region head carries a plain sub-line (`Timeline` reads `Milestones and sprint progress`), role keycaps always carry the real role in the accessible label, and every button names its action literally.

## Colors

The palette is the Trail Map's own furniture at two times of day: cold floodlit slate at night, warm stock by day, with saturated trail colours doing real work. Full token values live in the frontmatter; the groups below explain where each colour earns its place. The day map's identity is one line: **the same mountain at the other time of day — warm stock underfoot, off-white plates laid on it, warm ink in the type, and the amber the only saturated note.** The ladder steps down from the plate to the stock to the rail, so hierarchy does not rest on the hairlines alone, and warm ink on warm stock is deliberate — a cool ink reads dirty on this field. The day map is a translation of the night map, never an inversion, and only paper, ink, and rim change with the light.

### Primary
- **Brand Amber** (night `#F0C040` / day fill `#8A5A0A`): the only action colour in the system — the same family as the LX plate in the rail. Primary buttons, the global focus ring, the today marker on the Timeline, the "You are here" post, and the traced-row tint all come from this one hue. At night one value carries every amber job: fill, ring, marks, and links. By day the hue splits at the paper line: the primary action is the deep amber `#8A5A0A` carrying a light label (`#FFF9EC`, 5.64:1), while everything drawn on the sheet — focus ring, marker strokes, links — wears the ink amber `#7E5C00`, because the plate yellow on the warm stock is 1.60 to 2.34:1 and cannot mark anything; the plate yellow `#D4A017` itself cannot hold a light label (2.27:1). The day primary button always carries a 1px ink-amber rim: at day the warm plate sits on a warm sheet, so the rim is mandatory everywhere on the day map, and its own edge against the sheet passes 5.05:1 and up; the Same-Mountain Rule already says only paper, ink, and rim change with the light. One named miss rides with the owner-approved marks value: ink-amber marks on the pressed chrome step read 4.13:1 against a 4.5 bar — the nearest passing value is a one-notch deeper ink amber `#745400`, whose cost is losing the approved `#7E5C00` and warming the rim away from the plate fill (1.04:1 against the fill, both internal to the button); every resting surface passes 4.59:1 and up, and marks on the chrome steps are transient. Its rarity is the point: if two things wear the amber, one of them is wrong.
- **What stays out of the amber.** Sun gold (`#E8A33D`, warning and a lift-line series hue) keeps its jobs: warning must stay far from danger red because the two are read side by side (`approaching` next to `exceeded`), and gold is the only warm state hue that clears that gap. The retired patrol orange is earned back by nothing — as text it cannot clear AA on the night panel without lightening into the salmon register that danger ink already owns, and the Job-Colour Rule forbids a second warm action hue. Danger keeps red; the orange simply leaves the palette.

### Secondary
- **Difficulty Ribbons** (lowest green, normal blue, high red, highest black, with their ink and rim): priority encoding and only that. A ribbon's tone follows the project's own configured priority names in rank order, with position 0 as the highest rank (black). The fills are identical at both times of day; only the rim flips so the black chip keeps an edge on paper.

### Tertiary
- **Lift-Line Series Hues** (glacier cyan, sun gold, plum, meadow green, slate): per-project and data-series identity only. Sprint runs on the Timeline wear these, and so do data series elsewhere. They never carry state and never carry priority.

### Neutral
- **Map Furniture** (ground, band, rail, panel, column, input, overlay, plus the chrome hover/active pair): the app field, the cap band, the nav rail and top bar, cards and panels, board columns and profile fill, form fields, and scrims. Night values are the floodlit slate family; day values are the warm day family — warm stock underfoot with off-white plates laid on it, never the cool drafting sheet. Ground and panels sit at the same card tone by day (`#FFFDF9`), so a card reads as a plate by its hairline and its place rather than by standing off the ground; the rail is the darkest chrome at night and the warm frame sunk around the sheet by day, and the band and the surface panes share that one chrome tone. The day ladder runs ground `#FFFDF9`, panel `#FFFDF9`, column `#F9F6EF`, rail and band `#F7F3EA`, with the input the same off-white as the panel — the input is the map's blank: cut dark into the slate at night, printed on the sheet by day. The chrome steps are their own pair below the rail (hover `#E6DECD`, active `#DCD3BE`, 1.21 to 1.34:1 off the rail), because the content's subtle hover would vanish on the light chrome. The steps are measured, not implied: the column sinks 1.06:1 and the rail 1.09:1 below the ground, a hover fill stands 1.16:1 off the panel and a pressed fill 1.13:1 below that. The two state fills (hover `#F1ECE0`, pressed `#E6DFCE`) carry a hovered or pressed row on every host, board columns included: the cursor casts shadow on the day map where it throws light on the night map. State steps are tonal, not graphic — the state is carried by its fill step plus the inked border, never by fill alone.
- **Ink** (primary, secondary, tertiary, muted, inverse, plus danger, warning, and success ink): body text is snow-white at night and warm ink by day, never pure white. Secondary ink carries meta and labels, muted ink carries sub-lines and timestamps, inverse ink rides on filled chrome that is not the accent — the amber fill always carries its own accent ink (`#10161B` night, `#FFF9EC` day). The day ramp is a warm ladder (`#2A241B` / `#544B3C` / `#615846`, with a tertiary step `#635A49`): secondary and muted are pulled darker than the old map because the pressed chrome step is the binding host — every ink of the ramp clears 4.5:1 on every day surface and state fill, a row pressed while traced included — and the quiet register of a sub-line rides its size and place, not a whisper tone.
- **Borders** (default, subtle, strong, focus, input): 1px hairlines do all the separating work that shadows would do in another system. The day map draws two line weights: the pencil hairline (default, subtle) for separators and plate outlines — quiet by design at 1.56 to 1.96:1, the Same-Mountain parity with the night hairlines at 1.03 to 1.48:1 — and the inked line (strong, input, both `#5E5343`) for everything that must be seen: hovered and active plates, field boundaries, and the pressed row's edge, 5.05 to 7.40:1 on every day surface and state fill. The pencil hairline is a named exception to the 3:1 hairline bar (it separates, it never identifies; its nearest passing value is the inked line itself, whose cost is a boxed-wireframe board and the end of the two-weight vocabulary). Strong borders mark the active nav plate and hovered rows.

### State and Stamp Ink
- **State Hues** (danger, warning, success, info) and their tinted grounds: meaning only. They fire for WIP approaching or exceeded, sync degraded or failed, and overdue dates, and nowhere else.
- **Stamp Ink** (sync blue, fail red, with their tinted grounds): the sync, approval, and revision stamps. The stamp is the record that two systems agreed, so it wears ink, not chrome.

### Named Rules
**The Job-Colour Rule.** Ribbon colour encodes priority; series hues encode identity; state hues encode meaning. A colour never holds two jobs on one screen, and no colour appears decoratively.

**The Never-Colour-Alone Rule.** Every difficulty ribbon carries its rank numeral on the chip and the project's configured priority name in its accessible label. Colour is the fast path, never the only path.

**The Same-Mountain Rule.** The day map is a translation, never an inversion. Ribbons keep their fills, plates keep their anatomy, and only paper, ink, and rim change with the light.

**The Snow-Ink Rule.** Body ink is snow-white at night (`#EAF2F6` register), never pure `#FFFFFF`, and never a light-mode inversion of the same value. Ink always comes from the map's own palette.

## Typography

**Signage Font:** Space Grotesk (with system sans fallback)
**Guide Font:** IBM Plex Sans (with system sans fallback)
**Surveyor Font:** JetBrains Mono (with SF Mono and Fira Code fallbacks)

**Character:** three voices with strict jobs. Signage speaks in confident grotesque caps with open tracking, the way a trail head speaks to a skier crossing the base area. Guide is the warm humanist register where the product's warm, playful, tactile voice lives, and it carries every sentence a human actually reads. Surveyor is the measured instrument: condensed mono tabular figures for keys, counts, altitudes, dates, and times. All three families are already in the project; no font is fetched from a CDN.

### Hierarchy
- **Signage brand** (700, 14px, +0.14em tracking, uppercase): the wordmark and product name in the rail.
- **Signage title** (600, 13px, +0.07em, uppercase): the top-bar project name.
- **Signage plate large** (600, 13px, +0.06em, uppercase): region headings (`Timeline`, `Needs attention`, `Column WIP`, `Recent activity`) and mobile menu links.
- **Signage plate** (600, 11px, +0.07em, uppercase): section plates and status-report labels (`Status report`, `Column WIP`, `Needs attention`, `Target`, `Tasks`).
- **Signage nav** (600, 12px, +0.06em, uppercase): rail links and rail controls.
- **Guide body** (400, 13px, line-height 17px): row titles, report values, void copy, button labels.
- **Guide sub** (400, 11px, line-height 15px): plain sub-lines and row meta.
- **Surveyor count** (400, 20px, line-height 22px, tabular): headline counts in the status report.
- **Surveyor key** (500, 11px, +0.02em, tabular): `KEY-123` route keys and repo slugs.
- **Surveyor ribbon** (700, 11px, tabular): the rank numeral inside a difficulty ribbon.
- **Surveyor stamp** (400, 10px, +0.06em, uppercase, tabular): stamp text.
- **Surveyor micro** (400, 10px, tabular): keycaps, meter state labels, and the profile's micro labels (peak dates, post labels, gate labels, the today flag).

### Named Rules
**The Three Voices Rule.** Signage names things in caps plates, Guide reads as sentences, Surveyor reports figures. There is no fourth voice and no family outside these three.

**The Tabular Figures Rule.** Every count, key, date, and time is set with tabular figures so numbers align from row to row and column to column. A proportional figure in a count is a defect.

Note on the build record: the direction called for a Signage replacement pass that would retire Space Grotesk. That pass did not ship; the built world keeps Space Grotesk and this record follows the build.

## Layout

The shell is one frame built from a cap band and a two-part grid below it. The cap band is 48px tall (56px on phones) and spans the whole window: its left cell is the brand cell (rail width), its right segment is the top-bar row, and its bottom hairline runs the full window width while the rail's right hairline begins beneath the band — the two hairlines meet in a T at (rail width, band height) and never cross (The One Band Rule). Below the band: a sticky left rail and a content frame. The rail is 200px open and 48px collapsed on desktop, 168px in the mid band (768px to 1023.98px), and gone below 768px where a labelled `MENU` control opens the navigation as a full-screen panel with a scrim (never a bare hamburger hiding the only routes). One navigation affordance per band: the labelled menu is phone-only and the mid band keeps the rail. The rail carries navigation and nothing else — no account cluster at its bottom. The brand cell carries the lockup — the LX monogram (`docs/brand/lexa-mark.svg`, inlined through the `--lx-brand-plate` / `--lx-brand-ink` tokens) 8px from the signage wordmark — and, at the cell's right edge, the rail's collapse control: icon-only at 32px, the sidebar's own top-right, where a reader looks for it. Collapsed, the cell is that control alone, centred with 8px clearance, and the mark returns when the rail opens. The brand plate is the one colour in the app that is not the world's: identity is the brand's job, and the mark ships its own plate (the deeper day plate on the light theme, as the favicon does).

The top bar is the cap band's right segment (48px minimum, 56px on phones) and holds the pane toggle on chat and wiki (labelled `Threads` / `Pages`, wearing the surface's own icon so it cannot be mistaken for the rail's collapse control, icon-only below 768px), the project name with its slug, the project switcher, the theme toggle and the user keycap — **no primary action of its own**: creating work belongs to the surface that owns it (each board column's add, the tasks list's `New task`), so a screen shows one patrol-amber action, the one it means. Chrome pills run **one step below the row** (32px on desktop, 44px on touch): at row height they filled the band and read as pressing its edges. The chrome rides a tighter inline gutter than the page body — 16px on desktop, 12px on tablet and phone — and stays at the window's edges, so the project name and the account cluster sit close to the frame; the narrow content column is a reading measure for the page body, never a cage the top bar is pulled into.

On chat and wiki a second column joins the left system instead of standing beside it: the threads pane and the wiki page tree dock under the cap band against the rail as one rail-toned block — one subtle hairline between nav group and pane, one default hairline at the system's outer edge — at 280px (≥1440px) or 260px (1024–1439px), or as a 288px drawer beneath the band below 1024px (The One Left System Rule). The pane shares the rail's row geometry: 36px rows (44px touch), 8px symmetric side insets, 4px gaps. No collapsed stub band exists. The pane is open by default at every width and the cap band's labelled `Threads` / `Pages` control owns open and close; below 1024px it opens as a drawer beneath the band over a scrim. The content lane keeps its reading measure at 75ch for prose and message text (wiki prose, chat bubbles) while code, diffs, tables and the profile panorama may span their column; freed width becomes symmetric air and masthead width, never longer body lines (The Reading-Measure Rule).

The page frame pads 10px 24px 16px on desktop and 14px 12px on phones. `page-frame-narrow` caps the *body* at `--lx-content-max` (1200px) for the surfaces that genuinely read as a form or a document — the settings pages and the task detail — while the work surfaces (dashboard, projects picker, tasks, milestones, swimlanes, chat, wiki) span the frame: their width is content, and their text is measured by `The Reading-Measure Rule` instead of by the frame. A cap is a measure for a body, never a shell width. The dashboard grid is `minmax(0, 1.35fr) minmax(0, 1fr)`: Needs attention left, Column WIP right, collapsing to one column below 1024px. The first viewport at 1440x900 holds all six regions in contract order: shell (rail and top bar), status report strip, timeline panel, needs attention, column WIP meters, recent activity. On phones the order is status report, timeline as a pinned horizontal strip, needs attention, then WIP meters.

Density is status-report density. List rows are 36px on desktop and never below 44px on touch. The spacing scale is 4px with steps 4, 8, 12, 16, and 24. Interactive targets are at least 32px on desktop and 44px on touch. The horizontal scrollers (report strip, profile panorama) scroll inside their own cards so a wide panorama never widens the page. Mobile chrome respects `env(safe-area-inset-bottom)`, and nothing overflows horizontally at 390px or 1440px.

### Named Rules
**The One Band Rule.** The cap band is one 48px band (56px on phones) across the whole window: the brand cell and the top-bar row share its rail tone and its midline, its bottom hairline runs the full window width, and the rail's right hairline starts below the band so the borders meet in a T at (rail width, band height) and never cross. The brand cell carries the lockup plus the rail's collapse control at its right edge — icon-only, the sidebar's own top-right — and collapsed the cell is that control alone.

**The One Left System Rule.** On chat and wiki the rail and the surface pane (threads, page tree) form one rail-toned left system below the cap band: a subtle hairline divides nav group from pane, one default hairline runs the system's outer edge, the pane shares the rail's row geometry (36px rows, 8px symmetric insets, 4px gaps), and no collapsed stub band exists — the pane is docked at ≥1024px (280px ≥1440px, 260px below) or a 288px drawer beneath the band under it, open by default at every width, with the cap band's `Threads` / `Pages` control owning open and close.

**The Reading-Measure Rule.** Readable text caps at 75ch (wiki prose, chat message text); code, diffs, tables and the profile panorama may span their column; the slack beside a measure is symmetric designed air, and the measure never stretches to fill it.

**The Whole-Cell Repack Rule.** Every cap and grid repacks in whole cells. A scroller is capped to whole rows measured from the rendered row height (the activity strip reads its cap from the DOM, so it lands on three 40px rows or five 30px rows, never a half row), and a card is never cut.

**The Guide-Word Rule.** Every panel head names the span in view. The Timeline sub-line reads `Milestones and sprint progress,` followed by the live date span (`Sep 27 to Nov 21`), and it recomputes as content passes.

**The Side-Fill Discipline Rule.** Capacity and WIP fills are exactly proportional to real counts against the ruled limit. The limit is ruled at the meter's end as a 2px line, the fill never overshoots it, and the meter never lies by scale.

**The Duration-as-Length Rule.** Every time bar is exactly proportional to real duration. Sprint runs descend at their true span; where truth to scale fails (a run without dates), ticks and numerals replace the decorative bar, and a minimum length is used only when there is nothing to measure.

## Elevation & Depth

This is a hybrid system: surfaces sit flat on the ground and overlays lift. Panels, cards, rows, plates, and the status report carry a 1px border and no shadow at all. One shadow layer is reserved for things that genuinely float above the map: dialogs, slideovers, popovers, and a card being dragged. Toasts and tooltips read as elevated surfaces through their own token families, not through extra shadow depth. Focus is not elevation: the global focus rule paints a 2px brand-amber outline with 2px offset and suppresses any focus shadow.

### Shadow Vocabulary
- **Small** (`box-shadow: 0 1px 2px rgba(4, 7, 10, 0.5)`): resting shadow for small lifted chrome.
- **Medium** (`box-shadow: 0 6px 16px rgba(4, 7, 10, 0.55)`): popovers and menus.
- **Large** (`box-shadow: 0 16px 40px rgba(4, 7, 10, 0.65)`): dialogs and modal surfaces.
- **Drag** (`box-shadow: 0 10px 28px rgba(4, 7, 10, 0.7), 0 0 0 1px rgba(240, 192, 64, 0.35)`): a card in transit, with a brand-amber rim so the dragged object stays identifiable.
- **Slideover** (`box-shadow: -6px 0 28px rgba(4, 7, 10, 0.6)`): the task slideover edge.
- Day-map values trade the black cast for a warm cast at the same geometry; full values are the shadow tokens in `app/styles/phosphor.css`. One named pair rides with them: the dialog plate against the day scrim reads 2.50:1 at its edge (2.69:1 where the scrim falls on the rail) — the dialog is identified by its plate, its 1px border, and the large shadow, not by edge luminance alone (the night pair is 1.24:1). The nearest passing scrim is `rgba(42, 36, 27, 0.50)`; its cost is a half-dark veil that reads as blackout over a working tool.

### Named Rules
**The One-Lift Rule.** Exactly one shadow vocabulary is reserved for lifted overlays (dialogs, slideovers, popovers, dragging cards). Nothing else floats: not rows, not plates, not panels, not buttons at rest.

## Shapes

The form language is printed map furniture. Section panels and the profile card are gently rounded 10px plates with a 1px hairline border. Rows, controls, and buttons share a tighter 6px plate radius so a list reads as one carved surface. Stamps, keycaps, and skeleton blocks take a 4px corner, the smallest plate on the map. Difficulty ribbons are pill-ended chips (8px on a 16px tall chip, 10px on the 20px large variant) and so are filter chips (9999px). Void plates are the one dashed silhouette in the system: 1px dashed hairline, 6px radius, transparent ground, so an empty region reads as an outlined slot rather than a broken card. The SVG furniture follows the same geometry: 1px ridge and axis strokes, 1.5px station posts, 2px gates and today marker, 6px run strokes with a 2px progress overlay.

## Components

### Signage Plates
- **Character:** every region, control label, and nav item wears the same trail-signage anatomy.
- **Shape:** uppercase Signage caps, tight plate (11px) or large plate (13px), secondary ink for labels and primary ink for region headings, no border of their own.
- **Use:** status-report labels, region heads with their plain sub-line beneath, rail links, mobile menu links.

### App Rail and Top Bar
- **Style:** the cap band is one 48px rail-coloured strip across the window (52px on phones): the brand cell (rail width — 200px open, 48px collapsed, 168px mid band) at left, the top-bar row at right, one full-width 1px bottom hairline under both, and the rail's right hairline beginning below the band (The One Band Rule). The rail below carries 36px nav rows as signage plates at 4px gaps and one foot row: the collapse control.
- **Default / hover / active:** links rest in secondary ink on transparent; hover fills the card-hover tone and lifts the text to primary ink; the active link takes the card-active fill with a strong 1px border. Pressed states use the card-active fill.
- **Collapsed rail:** labels leave the layout but stay in the accessible name, so the icon-only plate is still announced. The brand cell carries the 24px mark alone (12px clearance each side) and the foot control becomes a 40px-wide icon plate whose glyph sits ≥12px from both rail edges; no resting ink comes within 8px of a rail edge.
- **Mobile:** below 768px the rail is replaced by a labelled `MENU` control (44px target) opening a full-height nav panel over a scrim; menu links are 44px minimum rows in large-plate caps, and the panel head is the brand row (mark plus `Lexa`) above the project switcher block. In the mid band (768–1023.98px) the 168px rail with labelled links is the only navigation — the labelled menu is phone-only.
- **Copy:** `Dashboard`, `Board`, `Tasks`, `Milestones`, `Swimlanes`, `Wiki`, `Chat`, `Menu`, `Threads`, `Pages`, `Collapse`, `Expand`, `Theme`, `Project`, `Project settings`, `Create new project`.

### Surface Pane (Threads and Page Tree)
- **Character:** on chat and wiki a second column of the same left system — the threads list and the wiki page tree join the rail instead of standing beside it (The One Left System Rule).
- **Shape:** rail-toned (`--lx-surface-elevated`), 280px wide at ≥1440px and 260px at 1024–1439px, docked under the cap band; a 1px subtle hairline divides it from the nav group and one 1px default hairline marks the left system's outer edge. Below 1024px it becomes a 288px drawer beneath the band over the overlay scrim. Interior shares the rail's row geometry: 8px symmetric side insets, 4px gaps, 36px rows (44px touch), a 36px head row (`THREADS` / `PAGES` plate plus a surveyor-micro count), then control rows (`New chat` ghost button and search on chat; search and `New page` on wiki) and the scrolling row list.
- **States:** docked · drawer (Escape, scrim, and the top bar's `Threads` / `Pages` toggle close it) · closed (no stub band; the content lane takes the width) · loading (30px skeleton rows) · empty (`No threads yet — start a conversation`, `No pages yet`) · search-no-match (`No threads match` / `No pages match` with `Clear search`) · error (danger void `Threads could not be read.` / `Pages could not be read.` with `Retry`) · long content (internal scroll, ellipsised titles, 16px tree indent per level).
- **Copy:** `THREADS`, `PAGES`, `New chat`, `Search threads…`, `New page`, `Clear search`, `Retry`.

### Status Report Strip
- **Character:** today's conditions on one row, plain labels over real numbers.
- **Shape:** a full-width panel (10px radius, 1px border, 44px minimum height) of items separated by 1px subtle dividers, each item a plate label above its value; the first item flexes, the action link sits right.
- **Content:** `Status report` (sync stamp plus repo and issue in figures), `Column WIP` (`02 approaching`, `01 exceeded` with danger ink when non-zero), `Needs attention` (20px count), `Target` (milestone name plus due text, danger ink when overdue), `Tasks` (3-digit count), and one action link (`Open board`, `Link repo`, or `Retry read`).
- **States:** loading (skeleton value blocks with a visually hidden `Reading the map` label) · synced (blue `synced` stamp) · degraded (sun-gold `out of sync` stamp with the out-of-sync issue number) · read failure (red `read failed` stamp with `GitHub state unknown` and a `Retry read` button) · no repo (`No repo linked` plus `Link repo`) · no columns (`No columns yet`) · no milestone (`No active milestone`) · long content (values truncate with ellipsis inside the strip).

### Timeline (the signature)
- **Character:** milestone progress drawn as a mountain panorama, the same grammar the Milestones page renders at full scale.
- **Shape:** a full-width panel card with a head (`Timeline` plate plus the guide-word sub-line `Milestones and sprint progress,` and the live span) over a self-scrolling SVG panorama: ridge and axis hairlines, ridge fill in the column tone at 0.55 opacity, peak lines with dots and labels (11px) and target dates (10px), sprint runs as 6px strokes in the lift-line series hues with a 2px progress overlay, station posts at task states, gate bars at `blocked-by` dependencies carrying the blocking key, a `Done` valley label, and the today marker with its brand-amber `You are here` post.
- **Motion:** run lines draw once per mount (220ms linear, inside the world's 180 to 260ms band) from their own measured dash length; nothing loops or breathes.
- **States:** loading (dashed skeleton ridge, `Reading the map…`) · empty (`No milestones yet`) · error (plain inline error `Milestones could not be read for this project.` plus `Retry`) · long content (3 or more milestones scroll horizontally with today pinned) · tracing (see Route Trace).
- **Copy:** `You are here`, `Done`, `Target`, `no date`.

### Route Trace (the named signature interaction)
- **Behavior:** hovering or keyboard-focusing a task row or activity entry draws that task's full descent on the Timeline: start dot at its milestone peak, ribbon down its sprint run, a station post at every `blocked-by` dependency (a closed lift renders as a gate bar with the blocking key), end post at the `Done` valley. The draw is 180ms linear per mount and snaps instantly under reduced motion. Blur or `Escape` clears it; clicking still opens the standard task slideover and never replaces the control.
- **States:** the traced source row takes the accent-subtle fill with a brand-amber border; a task with no route shows the plain void `This task has no route on the map` with the explanation `It sits in a lane with no sprint, so there is nothing to trace.`

### Needs Attention Rows
- **Character:** dense trail rows: ribbon, route key, title, column, assignee keycaps.
- **Shape:** 36px minimum rows (44px on touch) in a 38px ribbon column plus body; 13px title in Guide, 11px meta in muted Guide; 2px gaps between rows.
- **States:** hover and focus-visible (card-hover fill, strong border) · active (card-active fill) · traced (accent-subtle fill, brand-amber border) · loading (30px skeleton rows) · empty (`All clear, nothing needs patrol`) · error (danger void) · long content (the list scrolls with the column head sticky).
- **Copy:** `Urgent work and issues GitHub has closed`, `All clear, nothing needs patrol`.

### Column WIP Meters
- **Character:** capacity made honest; the meter never lies by scale.
- **Shape:** one row per column (name, count, state) over an 8px track in the input tone with a 2px limit rule at the end. Fills: meadow for ok, warning for approaching, danger for exceeded.
- **States:** ok (`ok`, muted state label) · approaching (warning fill and label) · exceeded (danger fill and label) · no limit (count only, aria says `no limit`) · empty (`No columns yet` with the sub `Open Board setup to lay out the runs.`) · loading (skeleton) · long content (the meter list scrolls).
- **Copy:** `approaching`, `exceeded`, `ok`.

### Recent Activity
- **Character:** dated activity stamps, plain text bodies.
- **Shape:** 30px minimum rows in a 78px time column; time in muted Surveyor figures, body 13px Guide; the list caps to whole rows and scrolls for the rest.
- **States:** hover / focus-visible / active / traced (same fills as attention rows) · loading (skeleton rows) · empty (`Nothing has moved yet` with `Task edits and GitHub stamps show up here.`) · long content (cap plus internal scroll at every width).
- **Copy:** `Newest board changes first · the strip scrolls for more`.

### Difficulty Ribbons
- **Style:** 34x16px pill-ended chips (8px radius) with a 1px rim, the rank numeral inside in Surveyor 700. Large variant 46x20px (10px radius). Tone follows the project's configured priority order: position 0 (highest) is black, then high red, normal blue, lowest green.
- **State:** static encoding; the accessible name always carries the numeral and the configured priority name (for example `Ribbon 1, Critical`).

### Stamps
- **Style:** 20px tall, 4px radius, 1px border in the current ink, uppercase Surveyor 10px. `synced` takes stamp-sync ink on its tinted ground, `degraded` takes warning ink, `failed` takes fail ink.
- **Use:** sync state in the status report; approval and revision confirmations elsewhere (`Approved`, `Restored from rev 12`). A stamp is a functional confirmation, never texture.

### Keycaps
- **Style:** 20px tall, 4px radius, input-tone ground, 1px hairline, Surveyor 10px. Used for assignees and roles.
- **Role keycaps:** `Lift Ops` (superadmin), `Patrol` (team admin), `Rider` (member). The real role always rides the accessible label.

### Buttons
- **Shape:** 6px plate radius, Guide 13px labels, 36px base height (32px small, 44px large), 0 14px padding (0 10px small).
- **Primary:** filled with the brand-amber fill (`--lx-accent`) and the accent ink (`--lx-accent-ink`) — dark ink at both times of day, never the inverse ink — hover lifting one tonal step to the accent hover tone (`--lx-accent-hover`, 100ms background and border transition). By day the plate always carries a 1px rim in the mark amber (`--lx-border-focus`) — the fill cannot define its own edge on any day surface (1.60 to 2.38:1), and the rim supplies a 4.64:1 boundary against the sheet. Used for `New task` and the primary action of a region.
- **Ghost:** transparent with a default hairline border, secondary ink, hover filling the card-hover tone. Used for `Open board`, `Link repo`, `Retry read`, `Retry`.
- **Focus:** the global rule (2px brand-amber outline, 2px offset). **Disabled:** muted ink on transparent, no hover fill. **Loading:** the label stays plain and a skeleton or `Reading the map` register carries the wait.

### Void Plates and Skeletons
- **Void plate:** dashed 1px hairline, 6px radius, 16px padding, transparent ground, 13px Guide copy with a Signage plate title. The error variant takes a solid danger border with the danger-subtle ground and primary ink.
- **Skeleton:** 4px radius blocks in the card-hover tone (30px rows, 14px value blocks), pulsing only while loading and stopping dead under reduced motion.
- **Copy:** `No milestones yet`, `All clear, nothing needs patrol`, `No columns yet`, `Nothing has moved yet`, `No repo linked`, `No active milestone`, `The profile did not load`, `Project not found`, `Failed to load board`, `Reading the map…`.

### State Matrix
- **Rows, links, meters, activity entries:** default (flat, transparent or panel fill) · hover (card-hover fill, strong border) · focus-visible (global 2px brand-amber ring) · active (card-active fill) · disabled (muted ink, no fill) · loading (skeleton blocks) · error (danger void) · empty (dashed void with plain copy) · long content (internal scroll capped to whole cells, sticky heads where the list scrolls).
- **Buttons:** default · hover (tonal shift) · focus-visible (global ring) · active (pressed fill) · disabled (muted) · loading (plain label plus skeleton register).
- **Stamps and ribbons:** static encodings with fixed states only (`synced` / `degraded` / `failed`; four ribbon tones), never animated.

### Named Rules
**The Route Trace Rule.** The signature interaction is hover-or-focus driven, keyboard equivalent, cleared by blur or `Escape`, and additive: it draws the route and leaves every standard control (click to open the slideover) untouched.

**The State-Is-Signal Rule.** Colour, position, and motion communicate priority, type, WIP state, and sync state. A surface that renders state ambiguously is a defect, and a decorative use of a state colour is the same defect in reverse.

**The Surveyed-Redraw Rule.** Motion is a redraw of surveyed lines, once per mount: 180ms for the Route Trace, 220ms for the profile runs, both linear, both inside the 180 to 260ms band. Nothing loops, breathes, or eases in ambiently except the loading skeleton pulse, and reduced motion snaps every draw to its final state.

## Do's and Don'ts

### Do:
- **Do** keep every colour on its job: ribbon for priority, series hue for identity, state hue for meaning, brand amber for action and position.
- **Do** double every ribbon with its rank numeral on the chip and the project's configured priority name in the accessible label.
- **Do** set every count, key, date, and time in the Surveyor voice with tabular figures.
- **Do** hold list density at 36px desktop rows and 44px touch rows on the 4px scale, and cap scrollers to whole rows measured from the rendered row height.
- **Do** keep panels flat (1px hairline, 10px radius) and reserve the shadow vocabulary for lifted overlays only.
- **Do** draw the profile runs and the Route Trace once per mount (180 to 260ms linear) and snap them to final state under reduced motion.
- **Do** put the plain name of every control and state in the interface, with metaphor display names beside plain truth.
- **Do** let the status-report strip report only what the API can prove: repo, out-of-sync issues, WIP counts, milestone target, task count.

### Don't:
- **Don't** use a state colour for decoration or an identity hue for state; ambiguous colour is a defect.
- **Don't** let a ribbon carry colour alone, and don't fix ribbon tones to priority semantics: they follow each project's configured priority names in rank order.
- **Don't** float anything but dialogs, slideovers, popovers, and dragged cards; no ambient shadows on rows, plates, panels, or resting buttons.
- **Don't** invert the day map: never swap ribbons or plates, never use pure white ink, never turn the translation into a negative.
- **Don't** animate ambiently: no loops or breathing effects beyond the loading skeleton pulse, no motion that survives a reduced-motion request.
- **Don't** invent sync truth the API cannot prove: no relative sync timestamp, no `Retry sync` control, and no history series the data cannot back.
- **Don't** stretch a meter fill past the ruled limit or imply capacity the counts do not support.
- **Don't** cut a card or a row: repack in whole cells instead.

## Declarations (the honest record)

These are the build's declared boundaries. They are recorded, not hidden, and each one names the reason.

- **No `Retry sync` control and no relative sync timestamp.** The API exposes no sync-status source and no sync-trigger endpoint (`shared/types.ts` carries no sync timestamp; `app/lib/api.ts` has no sync endpoint). The status report stamps only what a read can prove, and the failure branch stamps `read failed` with `GitHub state unknown` and a `Retry read` button instead of claiming a GitHub state the client never saw. Both controls land when a sync-trigger API ships.
- **No pulse-strip history.** The direction's kept line asks every moving headline number to show its recent history; nothing in the API keeps a history series, so the rule is named and not built.
- **The board is adaptation only this run.** Its only change is the `?new=1` deep link from the shell's primary action (which clears the parameter and falls through to the board's setup void when the project has no columns or swimlanes). Route Trace reaches board cards in a later pass.
- **This run converted the app shell, the project dashboard, and the projects picker.** Every other surface (board, tasks, milestones, wiki, settings, assistant, login) inherits the tokens with its old component language. The mixed world is planned scope, not drift.
- **The owner keycap is not derivable client-side.** Role keycaps render `Lift Ops` (superadmin), `Patrol` (team admin), and `Rider` (member) with the real role in the accessible label; an owner-specific keycap waits on an owner signal the client can actually read.
- **Error branches are wired but not runtime-forced.** They are implemented and traced in code; none was forced in a live session.
- **Loading skeletons are typecheck-verified.** They landed after the last browser pass and were not captured in a render.
- **Reduced motion is proven by rule, not by an emulated capture.** The `prefers-reduced-motion` block that snaps both draws and the skeleton pulse is the evidence; no emulated-profile capture exists.
- **`wireframes/` is a retired archive and is not a design source.** It is absent from this checkout; `DESIGN.md` is the single source of truth for tokens from now on — the frontmatter is normative, and `.impeccable/design.json` mirrors it.
- **`docs/design-system.html` is a frozen primitive-markup reference** for the ported component vocabulary. It is not updated by this world and is not a token source.
- **Scope of this record's palette.** The world's furniture, state, stamp, series, chip, and type tokens are carried above. The tooltip surface, selection tint, dragging tint, tertiary ink, and chip badge tones were promoted into the frontmatter by this reconciliation and no longer live only in `app/styles/phosphor.css`. (The scrollbar tones entered the record with the earlier day-surface redesign.)
