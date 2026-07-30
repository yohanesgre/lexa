# Lexa Design System — PHOSPHOR

> **PHOSPHOR** — *A warm-phosphor workspace for game teams. Dense as a memory map, readable as a tuned HUD, and alive like a CRT at 2 AM.*

---

## 1. Design Principles

**1. The screen is a cathode, not a canvas.**
Lexa is a tool you stare at for hours alongside engines and terminals. The dark palette is warm — amber-tinted blacks, not cold slate. Light mode is a daylight translation, not an inversion. Every surface has temperature.

**2. Density is the game loop.**
The Kanban board must display 30+ cards at 1080p without vertical scroll. Padding is earned, not assumed. Cards are compact, columns are narrow, and every pixel carries state. This is a tracker grid, not a Pinterest board.

**3. Color is signal, not decoration.**
Priority, type, WIP state, and GitHub sync are communicated like status LEDs on hardware — hue first, luminance second, text third. The palette is small and disciplined: phosphor amber, green, cyan, and alarm red. No rainbow gradients, no decorative accents.

**4. Type does the talking.**
With minimal chrome, hierarchy is built through three distinct voices: a geometric display face for headings, a neutral grotesque for body and UI, and a technical mono for IDs and meta. No all-caps shouting. Weight and color create structure.

**5. Motion is a state machine.**
Animations are 150–250ms state transitions — drag, open, collapse. They answer "what happened?" not "look at me." No bounces, no elastic springs, no staggered entrances. Ease-out curves only. Reduced motion is full support, not a degraded experience.

---

## 2. Color System

### 2.1 Primitive Palette

Do not use primitives in components. Always route through semantic tokens. Primitives exist only to define the token values.

| Token | Dark Hex | Light Hex | Role |
|-------|----------|-----------|------|
| `warm-black` | `#0C0B09` | `#0C0B09` | Deepest background, overlays |
| `warm-950` | `#12100E` | `#F5F0EB` | Dark app bg / Light app bg |
| `warm-900` | `#1A1714` | `#EBE5DE` | Dark surface / Light surface |
| `warm-800` | `#24201C` | `#DDD5CC` | Dark elevated / Light border |
| `warm-700` | `#332E28` | `#C4BAB0` | Dark border / Light muted text |
| `warm-600` | `#4A443D` | `#9C9187` | Dark muted text / Light secondary text |
| `warm-500` | `#6B6560` | `#7A7169` | Mid gray (rarely used directly) |
| `warm-400` | `#948E88` | `#5C554F` | Dark secondary text / Light tertiary text |
| `warm-300` | `#B8B2AB` | `#3D3833` | Dark tertiary text / Light secondary text |
| `warm-200` | `#D6D0CA` | `#292521` | Dark placeholder / Light heading |
| `warm-100` | `#E8E4DE` | `#1A1714` | Dark heading / Light text |
| `warm-50` | `#F5F0EB` | `#12100E` | Dark inverted text / Light inverted text |

| Phosphor | Dark Hex | Light Hex | Role |
|----------|----------|-----------|------|
| `phosphor-amber` | `#F0C040` | `#D4A017` | Primary accent — focus, links, active states |
| `phosphor-amber-dim` | `#8A7020` | `#B8931A` | Amber hover, muted accent bg |
| `phosphor-green` | `#4ADE80` | `#16A34A` | Success, synced state, feature type |
| `phosphor-green-dim` | `#2D7A4A` | `#86EFAC` | Green hover, subtle bg |
| `phosphor-cyan` | `#22D3EE` | `#0891B2` | Info, medium priority, task type |
| `phosphor-cyan-dim` | `#1A6B7A` | `#67E8F9` | Cyan hover, subtle bg |
| `phosphor-red` | `#FF4444` | `#DC2626` | Danger, urgent priority, bug type |
| `phosphor-red-dim` | `#8A2020` | `#FCA5A5` | Red hover, subtle bg |
| `phosphor-pink` | `#F472B6` | `#DB2777` | Asset type, distinct fourth hue |
| `phosphor-pink-dim` | `#8A4068` | `#F9A8D4` | Pink hover, subtle bg |

### 2.2 Semantic Tokens (CSS Custom Properties)

Apply to `:root` for dark (default) and `[data-theme="light"]` for light.

```css
/* === DARK MODE (default) === */
:root {
  /* Surfaces — warm, layered, never cold */
  --lx-surface-app: #0C0B09;
  --lx-surface-elevated: #141210;
  --lx-surface-column: #12100E;
  --lx-surface-card: #1A1714;
  --lx-surface-card-hover: #24201C;
  --lx-surface-card-active: #2E2A24;
  --lx-surface-card-dragging: #24201C;
  --lx-surface-input: #0C0B09;
  --lx-surface-overlay: rgba(12, 11, 9, 0.85);
  --lx-surface-tooltip: #24201C;
  --lx-surface-selected: rgba(240, 192, 64, 0.10);

  /* Borders */
  --lx-border-default: #332E28;
  --lx-border-subtle: #1A1714;
  --lx-border-strong: #4A443D;
  --lx-border-focus: #F0C040;

  /* Text — warm white, never pure #FFF */
  --lx-text-primary: #F5F0EB;
  --lx-text-secondary: #948E88;
  --lx-text-tertiary: #6B6560;
  --lx-text-muted: #4A443D;
  --lx-text-inverse: #12100E;
  --lx-text-link: #F0C040;
  --lx-text-link-hover: #F5D76A;
  --lx-text-danger: #FF9999;
  --lx-text-warning: #FCD34D;
  --lx-text-success: #86EFAC;

  /* Status backgrounds (low-opacity warm tints) */
  --lx-bg-danger-subtle: rgba(255, 68, 68, 0.10);
  --lx-bg-warning-subtle: rgba(240, 192, 64, 0.10);
  --lx-bg-success-subtle: rgba(74, 222, 128, 0.10);
  --lx-bg-accent-subtle: rgba(240, 192, 64, 0.10);

  /* Shadows — warm, soft, never blue-tinted */
  --lx-shadow-sm: 0 1px 2px rgba(12, 11, 9, 0.5);
  --lx-shadow-md: 0 4px 12px rgba(12, 11, 9, 0.6);
  --lx-shadow-lg: 0 12px 32px rgba(12, 11, 9, 0.7);
  --lx-shadow-drag: 0 8px 24px rgba(12, 11, 9, 0.8), 0 0 0 1px rgba(240, 192, 64, 0.25);
  --lx-shadow-slideover: -4px 0 24px rgba(12, 11, 9, 0.7);

  /* Focus — phosphor glow */
  --lx-focus-ring: 0 0 0 2px var(--lx-surface-app), 0 0 0 4px var(--lx-border-focus);
  --lx-focus-glow: 0 0 12px rgba(240, 192, 64, 0.20);

  /* Scrollbar */
  --lx-scrollbar-track: var(--lx-surface-app);
  --lx-scrollbar-thumb: #332E28;
  --lx-scrollbar-thumb-hover: #4A443D;
}

/* === LIGHT MODE === */
[data-theme="light"] {
  --lx-surface-app: #F5F0EB;
  --lx-surface-elevated: #FFFFFF;
  --lx-surface-column: #EBE5DE;
  --lx-surface-card: #FFFFFF;
  --lx-surface-card-hover: #F5F0EB;
  --lx-surface-card-active: #EBE5DE;
  --lx-surface-card-dragging: #FFFFFF;
  --lx-surface-input: #FFFFFF;
  --lx-surface-overlay: rgba(26, 23, 20, 0.35);
  --lx-surface-tooltip: #1A1714;
  --lx-surface-selected: rgba(212, 160, 23, 0.10);

  --lx-border-default: #DDD5CC;
  --lx-border-subtle: #EBE5DE;
  --lx-border-strong: #C4BAB0;
  --lx-border-focus: #D4A017;

  --lx-text-primary: #1A1714;
  --lx-text-secondary: #5C554F;
  --lx-text-tertiary: #7A7169;
  --lx-text-muted: #9C9187;
  --lx-text-inverse: #FFFFFF;
  --lx-text-link: #B8931A;
  --lx-text-link-hover: #D4A017;
  --lx-text-danger: #991B1B;
  --lx-text-warning: #92400E;
  --lx-text-success: #166534;

  --lx-bg-danger-subtle: rgba(220, 38, 38, 0.08);
  --lx-bg-warning-subtle: rgba(212, 160, 23, 0.08);
  --lx-bg-success-subtle: rgba(22, 163, 74, 0.08);
  --lx-bg-accent-subtle: rgba(212, 160, 23, 0.08);

  --lx-shadow-sm: 0 1px 2px rgba(26, 23, 20, 0.08);
  --lx-shadow-md: 0 4px 12px rgba(26, 23, 20, 0.10);
  --lx-shadow-lg: 0 12px 32px rgba(26, 23, 20, 0.14);
  --lx-shadow-drag: 0 8px 24px rgba(26, 23, 20, 0.18), 0 0 0 1px rgba(212, 160, 23, 0.25);
  --lx-shadow-slideover: -4px 0 24px rgba(26, 23, 20, 0.12);

  --lx-focus-ring: 0 0 0 2px var(--lx-surface-app), 0 0 0 4px var(--lx-border-focus);
  --lx-focus-glow: 0 0 12px rgba(212, 160, 23, 0.15);

  --lx-scrollbar-track: var(--lx-surface-app);
  --lx-scrollbar-thumb: #C4BAB0;
  --lx-scrollbar-thumb-hover: #9C9187;
}
```

### 2.3 Priority Colors

Priority uses a hardware-LED dot system. Colors are consistent across modes (the dark/light semantic tokens handle context).

| Priority | Hex | Name | LED Character |
|----------|-----|------|---------------|
| `priority-urgent` | `#FF4444` | Alarm Red | Solid, brightest |
| `priority-high` | `#F0C040` | Warning Amber | Solid, warm glow |
| `priority-medium` | `#22D3EE` | Terminal Cyan | Solid, cool phosphor |
| `priority-low` | `#6B6560` | Dim Gray | Hollow ring (not solid) |

### 2.4 Task Type Colors

Task types use a left-border accent on cards (3px) and small badges.

| Type | Hex | Name | Border/Badge Color |
|------|-----|------|-------------------|
| `type-feature` | `#4ADE80` | Phosphor Green | `#4ADE80` |
| `type-bug` | `#FF4444` | Phosphor Red | `#FF4444` |
| `type-task` | `#22D3EE` | Phosphor Cyan | `#22D3EE` |
| `type-asset` | `#F472B6` | Phosphor Pink | `#F472B6` |

### 2.5 WIP & Sync State Colors

| State | Hex | Background Token | Text Token |
|-------|-----|------------------|------------|
| `wip-ok` | `#4ADE80` | `--lx-bg-success-subtle` | `--lx-text-success` |
| `wip-approaching` | `#F0C040` | `--lx-bg-warning-subtle` | `--lx-text-warning` |
| `wip-exceeded` | `#FF4444` | `--lx-bg-danger-subtle` | `--lx-text-danger` |
| `sync-synced` | `#4ADE80` | `--lx-bg-success-subtle` | `--lx-text-success` |
| `sync-diverged` | `#F0C040` | `--lx-bg-warning-subtle` | `--lx-text-warning` |
| `sync-unlinked` | `#6B6560` | transparent | `--lx-text-muted` |

---

## 3. Typography

### 3.1 Font Stack

Lexa uses a three-voice system. Load all three via Google Fonts or self-host.

```css
/* Import via Google Fonts */
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&family=JetBrains+Mono:wght@400;500&family=Departure+Mono&display=swap');

:root {
  --lx-font-display: "Space Grotesk", -apple-system, BlinkMacSystemFont, sans-serif;
  --lx-font-body: "IBM Plex Sans", -apple-system, BlinkMacSystemFont, sans-serif;
  --lx-font-mono: "JetBrains Mono", "SF Mono", "Fira Code", monospace;
  --lx-font-micro: "Departure Mono", "JetBrains Mono", monospace;
}
```

**Voice rules:**
- **Display (Space Grotesk):** Page titles, dashboard project names, empty state headings, swimlane names. Geometric, quirky, technical. Never below 16px.
- **Body (IBM Plex Sans):** UI labels, buttons, card titles, wiki prose, descriptions. Neutral, highly readable, warm. The workhorse.
- **Mono (JetBrains Mono):** Task IDs, GitHub issue numbers, API keys, timestamps, inline code. Technical, legible at small sizes.
- **Micro (Departure Mono):** Tiny HUD labels, status readouts, WIP counters, priority abbreviations in dense views. Used at 10–11px only. Gives a telemetry/tracker feel.

### 3.2 Type Scale

All sizes in `rem` (base = 16px).

| Token | Size | Line-Height | Weight | Letter-Spacing | Font | Usage |
|-------|------|-------------|--------|----------------|------|-------|
| `text-2xs` | 11px | 14px | 500 | 0.02em | Micro | WIP counters, timestamps, HUD labels |
| `text-xs` | 12px | 16px | 400 | 0 | Body / Mono | Column headers, meta, IDs |
| `text-sm` | 13px | 18px | 400 | -0.01em | Body | UI chrome, buttons, nav |
| `text-base` | 14px | 20px | 400 | -0.01em | Body | Task card titles, default body |
| `text-md` | 15px | 22px | 400 | -0.01em | Body | Wiki body text |
| `text-lg` | 16px | 24px | 500 | -0.02em | Display | Modal titles, section headers |
| `text-xl` | 18px | 26px | 600 | -0.02em | Display | Page titles |
| `text-2xl` | 24px | 30px | 600 | -0.03em | Display | Dashboard project names |
| `text-3xl` | 30px | 36px | 600 | -0.03em | Display | Marketing / empty states |

### 3.3 Weight Rules

| Weight | Usage |
|--------|-------|
| 400 (Regular) | Body text, descriptions, wiki prose, UI labels, card content |
| 500 (Medium) | Column headers, button labels, badges, micro labels |
| 600 (Semibold) | Task titles, page titles, swimlane names, active nav |
| 700 (Bold) | **Never used.** 600 is the ceiling. |

### 3.4 Special Treatments

**Task Titles (Kanban cards):**
- Font: `--lx-font-body`
- Size: `text-base` (14px)
- Weight: 600
- Color: `--lx-text-primary`
- Line-height: 20px
- Max 3 lines, `overflow: hidden`, `line-clamp: 3`

**Task Descriptions (slideover):**
- Font: `--lx-font-body`
- Size: `text-md` (15px)
- Weight: 400
- Color: `--lx-text-secondary`
- Line-height: 22px

**Wiki Prose:**
- Font: `--lx-font-body`
- Size: `text-md` (15px)
- Weight: 400
- Color: `--lx-text-primary`
- Line-height: 26px (relaxed)
- Paragraph spacing: 12px
- Heading hierarchy: `h1` = `text-2xl/600/Display`, `h2` = `text-xl/600/Display`, `h3` = `text-lg/500/Display`

**Code / Monospace:**
- Font: `--lx-font-mono`
- Size: 12px
- Background: `--lx-surface-elevated`
- Padding: 2px 4px
- Radius: 4px
- Color: `--lx-text-secondary`

**HUD / Micro Labels:**
- Font: `--lx-font-micro`
- Size: `text-2xs` (11px)
- Weight: 500
- Letter-spacing: 0.02em
- Color: `--lx-text-muted` (default) or phosphor color (for status)
- Usage: WIP counters "05/08", task IDs "#042", sync status "SYNC"

---

## 4. Spacing & Sizing

### 4.1 Base Unit

Base unit is **4px**. All spacing tokens are multiples of 4.

| Token | Value |
|-------|-------|
| `space-1` | 4px |
| `space-2` | 8px |
| `space-3` | 12px |
| `space-4` | 16px |
| `space-5` | 20px |
| `space-6` | 24px |
| `space-8` | 32px |
| `space-10` | 40px |
| `space-12` | 48px |

### 4.2 Density Targets

Hard dimensions for high-density Kanban readability.

| Element | Width | Height | Notes |
|---------|-------|--------|-------|
| **Column** | 280px | 100% board area | Fixed width, horizontal scroll |
| **Column gutter** | 12px | — | Between columns |
| **Card** | 100% column | auto | Min-height 56px, padding 10px 12px |
| **Card gutter** | 8px | — | Between cards |
| **Swimlane header** | 100% board | 36px | Collapsible, spans all columns |
| **Board padding** | 16px | — | Outer padding |
| **Slideover** | 480px | 100vh | Fixed right panel |
| **Wiki sidebar** | 260px | 100vh | Fixed left panel |
| **Wiki content max-width** | 720px | — | Centered reading column |
| **Dashboard grid gap** | 16px | — | Between project cards |
| **Project card** | auto | 160px | Grid item, min-width 280px |

### 4.3 Border Radius

| Token | Value | Usage |
|-------|-------|-------|
| `radius-sm` | 4px | Badges, small buttons, inputs, code blocks |
| `radius-md` | 6px | Cards, dropdowns, popovers |
| `radius-lg` | 8px | Modals, slideover, panels |
| `radius-xl` | 12px | Dashboard cards, large containers |
| `radius-full` | 9999px | Pills, avatars, circular buttons |

---

## 5. Component Specs

### 5.1 KanbanCard

```
Background:    var(--lx-surface-card)
Border:        1px solid var(--lx-border-subtle)
Border-left:   3px solid var(--type-color)
Radius:        radius-md (6px)
Padding:       10px 12px
Shadow:        none (default)
Cursor:        grab
```

**States:**

| State | Visual Change |
|-------|---------------|
| **Hover** | Background → `--lx-surface-card-hover`; border → `--lx-border-default`; shadow → `--lx-shadow-sm` |
| **Active / Pressed** | Background → `--lx-surface-card-active`; `transform: scale(0.995)` |
| **Dragging** | Background → `--lx-surface-card-dragging`; shadow → `--lx-shadow-drag`; border-color → `--lx-border-focus`; opacity 0.95; `transform: rotate(1deg) scale(1.01)`; cursor: grabbing |
| **Selected** | Background → `--lx-surface-selected`; ring → `--lx-focus-ring` |
| **Focus (keyboard)** | Ring → `--lx-focus-ring`; subtle glow → `--lx-focus-glow` |

**Internal Layout (top to bottom):**
1. **Top row:** Type badge (left) + Priority dot (right, with tooltip)
2. **Title:** `text-base/600/Body`, 3-line clamp, margin-top 8px
3. **Meta row:** Assignee avatars (20px circle, stacked, max 3 + overflow) + `.card-meta-spacer` (flex: 1) pushing GitHub section to right edge + GitHub link badges (stacked, max 2 + overflow, Mono font) + sync indicator dot. margin-top 8px.
4. **Bottom row (optional):** Checklist progress `text-2xs/500/Micro`, color `--lx-text-muted`.

**Type Badge:**
- Height: 18px
- Padding: 0 6px
- Radius: `radius-sm`
- Font: `text-2xs/500/Body`
- Background: `var(--type-color)` at 10% opacity
- Text: `var(--type-color)` at full saturation
- Text shadow: none (no glow on badges — keep them readable)

**Priority Dot:**
- Size: 8px circle
- Color: `var(--priority-color)`
- Position: absolute top-right of card, 10px from edges
- Tooltip on hover: priority name
- **Low priority exception:** Not a solid dot — a 6px ring with 2px stroke in `#6B6560`, hollow center. Distinguishes it visually from solid dots.

### 5.2 Column

```
Background:    var(--lx-surface-column)
Border:        1px solid var(--lx-border-subtle)
Radius:        radius-lg (8px)
Width:         280px
Padding:       0 0 12px 0
```

**ColumnHeader:**
```
Height:        44px
Padding:       0 12px
Display:       flex, align-center, justify-between
Border-bottom: 1px solid var(--lx-border-subtle)  (only if cards present)
```

- **Name:** `text-xs/500/Body`, color `--lx-text-secondary`, uppercase, letter-spacing 0.05em
- **Count:** `text-2xs/500/Micro`, color `--lx-text-muted`, margin-left 6px (rendered as "05" not "5" — zero-padded in Micro font)
- **WipBadge:** Right-aligned (see 5.4)
- **Color strip:** 3px tall strip at top of column, color = `columns.color` (user-defined). Transparent if undefined.
- **Context menu (⋮):** Add task, Rename (inline input), Edit column (ColumnForm modal), separator, Delete (confirm dialog), Clear all tasks (confirm dialog)

**InlineAddTask (replaces AddTaskButton when open):**
- Replaces "+ Add task..." button. Opens on button click. Closes on Save/Cancel/Esc.
- `.inline-add-form`: background `--lx-surface-card`, border `1px solid --lx-border-focus`, radius 6px, padding 10px 12px, box-shadow `--lx-focus-glow`
- **Title input:** Width 100%, background `--lx-surface-input`, border `1px solid --lx-border-default`, auto-focused
- **Priority:** Row — `justify-between`. `select.prop-input` (width: 140px). 4 options with colored `●` prefix: Urgent `#FF4444`, High `#FF8844` (default), Medium `#F0C040`, Low `#A0A0A0`. Selected value color applied via `color` on `<select>` element (not `<option>` — see implementation note).
- **Type:** Row — `justify-between`. `select.prop-input` (width: 140px). 4 options with colored `●` prefix: Feature `#4ADE80` (default), Bug `#FF4444`, Task `#67E8F9`, Asset `#F9A8D4`. Same color-on-select trick.
- **Footer:** Right-aligned Cancel (`.btn-ghost`, 28px) + Save (`.btn-primary`, 28px). Save disabled if title empty.
- **Keyboard:** Enter saves, Esc cancels
- **Mutation:** Calls `createTask` on save, updates board cache via `setQueryData`

**AddTaskButton (fallback, when inline form not open):**
- Height: 32px, width 100%
- Background: transparent
- Hover: `--lx-surface-card-hover`
- Icon: Plus (Lucide), 14px, `--lx-text-muted`
- Text: "Add task...", `text-sm/400/Body`, `--lx-text-muted`
- Visible on column hover, or always in empty columns

### 5.3 SwimlaneHeader

```
Height:        36px
Padding:       0 16px
Background:    var(--lx-surface-elevated)
Border:        1px solid var(--lx-border-default)
Radius:        radius-md (6px)
Margin-bottom: 12px
```

- **Chevron:** 14px, `--lx-text-secondary`, rotates 90° when expanded
- **Name:** `text-sm/500/Display`, `--lx-text-primary` (Display font gives swimlanes personality)
- **Description:** `text-2xs/Body`, `--lx-text-secondary`, truncated to 80 chars, max-width 240px, `white-space: nowrap; overflow: hidden; text-overflow: ellipsis`. "read more" link (`text-2xs/Body`, `--lx-text-link`) opens modal with full text. Hidden when collapsed.
- **Count:** `text-2xs/500/Micro`, `--lx-text-muted`, margin-left 8px
- **Context menu (⋮):** Settings (swimlane form — name, description), separator, Rename (inline), Add Column (ColumnForm create), Delete (confirm dialog)
- **Hover:** Background → `--lx-surface-card-hover`
- **Collapsed:** Chevron points right; columns below hidden; description hidden

### 5.4 WipBadge

```
Height:        20px
Padding:       0 6px
Radius:        radius-sm
Font:          text-2xs/600/Micro
```

| Mode | Background | Text Color | Example |
|------|------------|------------|---------|
| **OK** | `--lx-bg-success-subtle` | `--lx-text-success` | "05/08" |
| **Approaching** | `--lx-bg-warning-subtle` | `--lx-text-warning` | "07/08" |
| **Exceeded** | `--lx-bg-danger-subtle` | `--lx-text-danger` | "09/08" |

Zero-pad counts under 10 for monospace alignment. Badge hidden if `wip_limit` is NULL.

### 5.5 PriorityBadge

Used in Task Detail property bar and filters.

```
Height:        22px
Padding:       0 8px
Radius:        radius-sm
Font:          text-2xs/500/Body
Display:       inline-flex, align-center, gap 4px
```

| Priority | Background | Text | Dot |
|----------|------------|------|-----|
| Urgent | `--lx-bg-danger-subtle` | `#FF9999` | `#FF4444` |
| High | `--lx-bg-warning-subtle` | `#FCD34D` | `#F0C040` |
| Medium | `rgba(34, 211, 238, 0.10)` | `#67E8F9` | `#22D3EE` |
| Low | `rgba(107, 101, 96, 0.10)` | `#B8B2AB` | `#6B6560` ring |

### 5.6 TypeBadge

```
Height:        18px
Padding:       0 6px
Radius:        radius-sm
Font:          text-2xs/500/Body
```

| Type | Background | Text |
|------|------------|------|
| Feature | `rgba(74, 222, 128, 0.10)` | `#4ADE80` |
| Bug | `rgba(255, 68, 68, 0.10)` | `#FF9999` |
| Task | `rgba(34, 211, 238, 0.10)` | `#67E8F9` |
| Asset | `rgba(244, 114, 182, 0.10)` | `#F9A8D4` |

### 5.7 TaskDetail (Slideover)

```
Width:         480px
Height:        100vh
Position:      fixed, top 0, right 0
Background:    var(--lx-surface-elevated)
Border-left:   1px solid var(--lx-border-default)
Shadow:        var(--lx-shadow-slideover)
Z-index:       50
```

**Overlay:**
```
Background:    var(--lx-surface-overlay)
Z-index:       40
```

**Internal Layout:**
- **Header:** 56px height, padding 16px, flex row. Close button (X, 20px) right. Breadcrumb: "Project / Board" `text-xs/400/Body` `--lx-text-muted`.
- **TitleEditor:** Full width, `text-xl/600/Display`, `--lx-text-primary`. Inline editable on click. Input: `--lx-surface-input` bg, `radius-md`, 12px padding, `--lx-font-display`. Save on blur/Enter.
- **PropertyBar:** Horizontal flex row, gap 12px, padding 12px 16px, border-bottom 1px `--lx-border-subtle`.
  - Column selector (dropdown)
  - Priority badge (dropdown)
  - Type badge (dropdown)
  - Assignee input (freeform, 32px height, `radius-sm`, `--lx-surface-input` bg, `--lx-font-body`)
- **TipTapEditor:** Flex 1, overflow-y auto, padding 16px. Prose styles (see 3.4). Placeholder: "Add a description..." `--lx-text-muted`.
- **GitHubLink section:** Padding 16px, border-top 1px `--lx-border-subtle`. Badge: "owner/repo #123", `text-sm/500/Mono`, `--lx-text-link`. Sync status dot + Micro label right-aligned.
- **Footer:** 48px height, padding 0 16px, border-top 1px `--lx-border-subtle`. Delete button (ghost, danger) left. Close button right.

### 5.8 WikiSidebar

```
Width:         260px
Height:        100vh
Background:    var(--lx-surface-elevated)
Border-right:  1px solid var(--lx-border-default)
Padding:       16px 0
```

**PageTree:**
- Indent per level: 16px
- Item height: 32px
- Padding: 0 12px 0 (12px + indent)
- Font: `text-sm/400/Body`, `--lx-text-secondary`
- Hover: bg `--lx-surface-card-hover`, `radius-sm`
- Active page: `--lx-text-primary`, `text-sm/500`, bg `--lx-surface-selected`, left border 2px `--lx-border-focus`
- Expand/collapse chevron: 14px, `--lx-text-muted`, margin-right 4px
- Drag handle (on hover): 14px, `--lx-text-muted`, cursor grab
- Add page button: 32px, full width, `text-sm/500`, `--lx-text-muted`, hover `--lx-surface-card-hover`

### 5.9 ProjectCard (Dashboard — Health Card)

Two variants share the same card shell. The health card is the canonical populated-state view.

```
Background:    var(--lx-surface-card)
Border:        1px solid var(--lx-border-default)
Radius:        radius-xl (12px)
Padding:       20px
Height:        160px                           (bare card)
Min-height:    200px                           (health card — taller for extra content)
Shadow:        none
Display:       flex, flex-direction: column
```

**Base content (both variants):**
- **Name:** `text-2xl/600/Display`, `--lx-text-primary`, margin-bottom 8px
- **Description:** `text-sm/400/Body`, `--lx-text-secondary`, 2-line clamp
- **GitHub icon:** If linked, 14px Lucide `Github`, `--lx-text-muted`, top-right 16px.
- **Settings button (⋯):** Top-right 12px, 28×28px ghost button. Opens project settings modal (name, description, GitHub repo, delete). Not present on bare variant.

**Bare variant (empty-state / settings backdrop):**
- **Stats row:** Absolute, 16px from bottom. `text-xs/500/Micro`, `--lx-text-muted`. Format: "042 TASKS · 003 COLS" (zero-padded, uppercase, Micro font).

**Health variant (populated dashboard):**
- **Status row:** Flex row, gap 10px, margin-top 12px.
  - **Health dot:** 8px circle. Green (`--lx-text-success`) = ok, amber (`--lx-text-warning`) = approaching, red (`--lx-text-danger`) = exceeded. Derived: any column WIP exceeded → red; urgent tasks present → amber; else green.
  - **Urgent badge:** If urgentCount > 0. `text-2xs/500/Micro`, uppercase, `--lx-text-danger` on `--lx-bg-danger-subtle`, 18px height, padding 0 5px, radius 4px. Format: "005 urgent" (zero-padded).
  - **Sync badge:** If syncCount > 0. Same dimensions. `--lx-text-warning` on `--lx-bg-warning-subtle`. Format: "002 sync" (zero-padded).
- **WIP mini bar:** Flex row, gap 3px, height 4px, margin-top 12px, radius 2px. One segment per column, colored by WIP state: green (ok), amber (approaching), red (exceeded), muted border color (empty). Flex values proportional to column task counts.
- **Footer:** Flex row, space-between, margin-top auto, padding-top 16px. Stats readout: "042 tasks · 005 cols" in `text-2xs/500/Micro`, `--lx-text-muted`, zero-padded.

**States:**
- **Bare card hover:** Shadow → `--lx-shadow-md`, border → `--lx-border-strong`, `translateY(-2px)`
- **Health card hover:** Same as bare.
- **Focus:** Ring → `--lx-focus-ring`

### 5.9b Aggregate Stats Bar

Row of 4 stat cards below the project grid. Always visible when projects exist.

```
Container:    grid, 4 equal columns, gap 16px
Card:         var(--lx-surface-card), border: 1px solid var(--lx-border-default), radius-xl (12px), padding 20px
Label:        text-2xs/500/Micro, --lx-text-muted, uppercase, letter-spacing 0.04em, margin-bottom 6px
Value:        text-3xl/600/Display (36px), --lx-text-primary, line-height 40px, letter-spacing -0.03em
```

| Card | Label | Value source | Conditional class |
|------|-------|-------------|-------------------|
| Total tasks | "Total tasks" | Sum of all project task counts | — |
| Active projects | "Active projects" | Project count | — |
| WIP exceeded | "WIP exceeded" | Count of projects with health "exceeded" | `.stat-value-danger` (`--lx-text-danger`) if > 0 |
| Out-of-sync tasks | "Out-of-sync tasks" | Sum of all project syncCounts | `.stat-value-warning` (`--lx-text-warning`) if > 0 |

All values zero-padded to 3 digits.

### 5.9c Needs Attention Section

Two-column grid below the stats bar. Hidden when both columns would be empty.

```
Container:    margin-top 32px
Grid:         2 equal columns, gap 16px
Card:         var(--lx-surface-card), border: 1px solid var(--lx-border-default), radius-xl (12px), padding 16px
Title:        text-lg/500/Display, --lx-text-primary, margin-bottom 12px
```

**Urgent tasks column:**
- Title: "Urgent tasks"
- Items: one row per urgent task across all projects.
  - Row: flex, gap 10px, padding 8px 0, border-bottom: 1px solid `--lx-border-default` (none on last).
  - Health dot: 8px red circle (`--lx-text-danger`), margin-top 5px.
  - Meta: Task title (`text-base/600/Body`, `--lx-text-primary`, text-overflow ellipsis) + subtitle (`text-xs/Body`, `--lx-text-secondary`, "ProjectName · ColumnName").
  - Task ID badge: `text-xs/500/Mono`, `--lx-text-muted`, flex-shrink 0.
  - Each row links to the task detail (`/$slug?task=id`).

**Out-of-sync GitHub issues column:**
- Title: "Out-of-sync GitHub issues"
- Items: one row per out-of-sync task.
  - Same layout as urgent tasks.
  - Amber dot (`--lx-text-warning`).
  - Subtitle format: "ProjectName · owner/repo#N".
  - Only shown when at least one project has `githubRepo` and out-of-sync tasks.

---

## 6. Motion

### 6.1 Philosophy

Motion answers "what happened?" not "look at this." All transitions are directional, short, and ease-out. No springs, no bounces, no choreographed entrances.

### 6.2 Durations

| Context | Duration | Notes |
|---------|----------|-------|
| Hover, active | 100ms | Instant feedback |
| Card drag start/stop | 150ms | Shadow and scale |
| Slideover open/close | 200ms | Panel + overlay |
| Column collapse/expand | 200ms | Height animation |
| Modal/dialog | 150ms | Scale + fade |
| Toast enter | 300ms | Slide from top-right |
| Toast leave | 150ms | Fade out |
| Wiki sidebar | 250ms | Width (mobile only) |

### 6.3 Easings

```css
--lx-ease-out: cubic-bezier(0.16, 1, 0.3, 1);
--lx-ease-in-out: cubic-bezier(0.45, 0, 0.55, 1);
```

Default: `--lx-ease-out` for everything.

### 6.4 Drag & Drop

**Pickup:**
1. Instant: `cursor: grabbing`
2. 150ms: `scale(1.01)`, shadow → `--lx-shadow-drag`, border → `--lx-border-focus`, opacity 0.95, `rotate(1deg)`
3. Continuous: zero-lag cursor follow (dnd-kit)

**Drop target:** Column bg flashes `--lx-surface-selected` for 100ms.

**Release:** Snap to position, 150ms ease-out. Invalid drop: horizontal shake (`translateX: -4px → 4px → 0`, 200ms).

### 6.5 Slideover Transition

**Open:**
- Overlay: opacity 0 → 1, 200ms
- Panel: `translateX(100%)` → `translateX(0)`, 200ms, `--lx-ease-out`

**Close:**
- Panel: `translateX(0)` → `translateX(100%)`, 200ms
- Overlay: opacity 1 → 0, 150ms (starts 50ms before panel finishes)

### 6.6 Card Entrance

New cards (creation only, not initial load):
- `scale(0.95)`, `opacity: 0` → `scale(1)`, `opacity: 1`
- Duration: 200ms, `--lx-ease-out`
- No stagger

### 6.7 Focus Glow (Phosphor Signature)

Keyboard focus on interactive elements adds a subtle phosphor glow:
```css
:focus-visible {
  outline: none;
  box-shadow: var(--lx-focus-ring), var(--lx-focus-glow);
}
```

This is the signature "PHOSPHOR" effect — a warm amber glow around focused elements, like a CRT cursor. Disabled on mouse focus (`:focus-visible` only).

### 6.8 Reduced Motion

```css
@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```
Functional state changes (drag shadow, selected ring, focus glow) remain visible. Only the *transition* is removed.

---

## 7. Iconography

### 7.1 Recommendation

**Lucide React** (`lucide-react`). Stroked icons at 1.5px stroke width. Icon shapes are neutral — the PHOSPHOR personality comes from color, type, and glow, not from icon style.

| Context | Size | Stroke |
|---------|------|--------|
| Inline (buttons, links) | 16px | 1.5px |
| UI chrome (nav, headers) | 18px | 1.5px |
| Empty states | 24px | 1.5px |
| Dashboard surfaces | 32px | 1.5px |

### 7.2 Icons by Surface

| Surface | Icons |
|---------|-------|
| **Kanban** | `GripVertical` (drag), `Plus` (add), `ChevronDown`/`ChevronRight` (collapse), `MoreHorizontal` (menu) |
| **Task Detail** | `X` (close), `Link` (GitHub), `CheckCircle2`/`AlertCircle` (sync), `Trash2` (delete), `Pencil` (edit) |
| **Wiki** | `ChevronRight`/`ChevronDown` (tree), `FileText` (page), `Search` (FTS), `Plus` (add), `GripVertical` (reorder) |
| **Dashboard** | `LayoutGrid`, `Key`, `Settings`, `Plus`, `Github` |
| **Settings** | `Trash2`, `Plus`, `GripVertical`, `Settings`, `Key`, `ExternalLink` |
| **Global** | `Moon`/`Sun` (theme), `Command` (shortcuts) |

### 7.3 Custom Icons

**Priority Glyphs (optional enhancement for dense views):**
Beyond the 8px colored dot, priority can use shape reinforcement at 10px:
- **Urgent:** Solid circle (same as dot)
- **High:** Solid triangle pointing up
- **Medium:** Solid diamond
- **Low:** Hollow ring (6px outer, 2px stroke, no fill)

Canonical indicator remains the colored dot. Shapes are optional for high-density views where color alone might be ambiguous.

**GitHub Octocat:**
Use Lucide `Github` (16px) or the official Octocat SVG mark. Color: `--lx-text-muted`.

**No custom task-type icons.** Type is communicated by the left border accent and the colored badge. Adding icons would compete with the color signal.

---

## 8. Tailwind Mapping

### 8.1 Config

```js
// tailwind.config.js
module.exports = {
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        lx: {
          surface: {
            app: 'var(--lx-surface-app)',
            elevated: 'var(--lx-surface-elevated)',
            column: 'var(--lx-surface-column)',
            card: 'var(--lx-surface-card)',
            'card-hover': 'var(--lx-surface-card-hover)',
            'card-active': 'var(--lx-surface-card-active)',
            'card-dragging': 'var(--lx-surface-card-dragging)',
            input: 'var(--lx-surface-input)',
            overlay: 'var(--lx-surface-overlay)',
            tooltip: 'var(--lx-surface-tooltip)',
            selected: 'var(--lx-surface-selected)',
          },
          border: {
            DEFAULT: 'var(--lx-border-default)',
            subtle: 'var(--lx-border-subtle)',
            strong: 'var(--lx-border-strong)',
            focus: 'var(--lx-border-focus)',
          },
          text: {
            primary: 'var(--lx-text-primary)',
            secondary: 'var(--lx-text-secondary)',
            tertiary: 'var(--lx-text-tertiary)',
            muted: 'var(--lx-text-muted)',
            inverse: 'var(--lx-text-inverse)',
            link: 'var(--lx-text-link)',
            'link-hover': 'var(--lx-text-link-hover)',
            danger: 'var(--lx-text-danger)',
            warning: 'var(--lx-text-warning)',
            success: 'var(--lx-text-success)',
          },
          accent: {
            DEFAULT: '#F0C040',
            hover: '#F5D76A',
            muted: '#8A7020',
          },
          priority: {
            urgent: '#FF4444',
            high: '#F0C040',
            medium: '#22D3EE',
            low: '#6B6560',
          },
          type: {
            feature: '#4ADE80',
            bug: '#FF4444',
            task: '#22D3EE',
            asset: '#F472B6',
          },
          status: {
            success: '#4ADE80',
            warning: '#F0C040',
            danger: '#FF4444',
            info: '#22D3EE',
          },
        },
      },
      fontFamily: {
        display: ['var(--lx-font-display)', 'system-ui', 'sans-serif'],
        body: ['var(--lx-font-body)', 'system-ui', 'sans-serif'],
        mono: ['var(--lx-font-mono)', 'monospace'],
        micro: ['var(--lx-font-micro)', 'monospace'],
      },
      fontSize: {
        '2xs': ['11px', { lineHeight: '14px', letterSpacing: '0.02em' }],
        xs: ['12px', { lineHeight: '16px' }],
        sm: ['13px', { lineHeight: '18px', letterSpacing: '-0.01em' }],
        base: ['14px', { lineHeight: '20px', letterSpacing: '-0.01em' }],
        md: ['15px', { lineHeight: '22px', letterSpacing: '-0.01em' }],
        lg: ['16px', { lineHeight: '24px', letterSpacing: '-0.02em' }],
        xl: ['18px', { lineHeight: '26px', letterSpacing: '-0.02em' }],
        '2xl': ['24px', { lineHeight: '30px', letterSpacing: '-0.03em' }],
        '3xl': ['30px', { lineHeight: '36px', letterSpacing: '-0.03em' }],
      },
      spacing: {
        1: '4px',
        2: '8px',
        3: '12px',
        4: '16px',
        5: '20px',
        6: '24px',
        8: '32px',
        10: '40px',
        12: '48px',
      },
      borderRadius: {
        sm: '4px',
        md: '6px',
        lg: '8px',
        xl: '12px',
        full: '9999px',
      },
      boxShadow: {
        'lx-sm': 'var(--lx-shadow-sm)',
        'lx-md': 'var(--lx-shadow-md)',
        'lx-lg': 'var(--lx-shadow-lg)',
        'lx-drag': 'var(--lx-shadow-drag)',
        'lx-slideover': 'var(--lx-shadow-slideover)',
      },
      transitionTimingFunction: {
        'lx-out': 'cubic-bezier(0.16, 1, 0.3, 1)',
        'lx-in-out': 'cubic-bezier(0.45, 0, 0.55, 1)',
      },
      transitionDuration: {
        'lx-100': '100ms',
        'lx-150': '150ms',
        'lx-200': '200ms',
        'lx-250': '250ms',
      },
      width: {
        'kanban-column': '280px',
        'slideover': '480px',
        'wiki-sidebar': '260px',
      },
      maxWidth: {
        'wiki-content': '720px',
      },
      zIndex: {
        'slideover': '50',
        'overlay': '40',
        'dropdown': '30',
        'sticky': '20',
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
};
```

### 8.2 shadcn/ui Integration

Map shadcn variables to PHOSPHOR tokens in `globals.css`:

```css
@layer base {
  :root {
    --background: var(--lx-surface-app);
    --foreground: var(--lx-text-primary);
    --card: var(--lx-surface-card);
    --card-foreground: var(--lx-text-primary);
    --popover: var(--lx-surface-elevated);
    --popover-foreground: var(--lx-text-primary);
    --primary: var(--lx-accent);
    --primary-foreground: var(--lx-text-inverse);
    --secondary: var(--lx-surface-column);
    --secondary-foreground: var(--lx-text-secondary);
    --muted: var(--lx-surface-column);
    --muted-foreground: var(--lx-text-muted);
    --accent: var(--lx-surface-selected);
    --accent-foreground: var(--lx-text-primary);
    --destructive: var(--lx-status-danger);
    --destructive-foreground: var(--lx-text-inverse);
    --border: var(--lx-border-default);
    --input: var(--lx-surface-input);
    --ring: var(--lx-border-focus);
    --radius: 6px;
  }
}
```

Override shadcn component padding where defaults are too generous (Dialog, DropdownMenuContent → 16px).

### 8.3 Usage Examples

```jsx
// KanbanCard
<div className="bg-lx-surface-card border border-lx-border-subtle border-l-type-feature rounded-md p-2.5 hover:bg-lx-surface-card-hover hover:shadow-lx-sm active:scale-[0.995] active:bg-lx-surface-card-active cursor-grab">
  <div className="flex items-center justify-between mb-2">
    <span className="inline-flex h-[18px] items-center px-1.5 rounded-sm text-2xs font-medium font-body bg-type-feature/10 text-type-feature">
      Feature
    </span>
    <span className="w-2 h-2 rounded-full bg-priority-high" title="High priority" />
  </div>
  <h3 className="text-base font-semibold font-body text-lx-text-primary leading-5 line-clamp-3">
    Implement player inventory system
  </h3>
  <div className="flex items-center gap-2 mt-2">
    <div className="w-5 h-5 rounded-full bg-lx-surface-column flex items-center justify-center text-2xs font-medium font-body text-lx-text-secondary">
      JD
    </div>
    <span className="text-2xs font-mono text-lx-text-muted">#42</span>
  </div>
</div>

// Slideover
<div className="fixed top-0 right-0 w-slideover h-screen bg-lx-surface-elevated border-l border-lx-border-default shadow-lx-slideover z-slideover transition-transform duration-lx-200 ease-lx-out">
  {/* content */}
</div>

// Wiki sidebar active item
<a className="flex items-center h-8 px-3 rounded-sm text-sm font-medium font-body bg-lx-surface-selected text-lx-text-primary border-l-2 border-lx-border-focus">
  <ChevronRight className="w-3.5 h-3.5 mr-1 text-lx-text-muted" />
  Game Design Doc
</a>

// Dashboard stat in Micro font
<span className="text-xs font-micro text-lx-text-muted uppercase tracking-wide">
  042 TASKS · 003 COLS
</span>
```

---

## 9. Accessibility Notes

- **Contrast:** `--lx-text-primary` on `--lx-surface-card` meets WCAG 2.1 AA (4.5:1) in both modes. `--lx-text-secondary` meets AA for large text and UI components (3:1). `--lx-text-muted` is decorative-only.
- **Focus:** All interactive elements use `--lx-focus-ring` + `--lx-focus-glow` on `:focus-visible` (keyboard only). The phosphor glow is subtle enough to not overwhelm but visible enough to aid navigation.
- **Color alone:** Priority and type never rely on color alone. Cards have text labels; slideover spells out values; priority dots have tooltips.
- **Motion:** `prefers-reduced-motion` removes transitions while preserving state visibility (see 6.8).
- **Touch targets:** Minimum 32px on one dimension. Cards are 56px+ tall.
- **Scrollbar:** Custom scrollbar styling uses `--lx-scrollbar-*` tokens. Thin (8px), `--lx-border-default` track, `--lx-border-strong` thumb.

---

*End of PHOSPHOR Design System. Implementation order: CSS variables → Tailwind config → shadcn theme mapping → KanbanCard → Column → Slideover → Wiki sidebar → Dashboard cards → Settings forms.*
