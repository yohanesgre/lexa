# toggle-aria-app-sweep — LX-13 part 2

## Problem
The design-system + wireframes (PR #214, submodule `cfb06b3`) pin one toggle
convention: a toggle button is any `<button>` exposing `aria-pressed`; the
accessible name is CONSTANT across states and equals/contains the visible label
text (WCAG Label in Name); state lives only in `aria-pressed` (visual `is-on`).
The app still had state-varying names, `role="switch"`/`aria-checked`, and
missing `aria-pressed`.

## Scope
`app/` only. Transcribe wireframe names; no new UI, no wireframe edits.

## Targets
- `AssistantSortableModelRow.tsx` — name = Model ID cell value.
- `AssistantMcpSection.tsx` / `AssistantProjectMcpSection.tsx` — name = row client label (`Linear`).
- `AssistantJevSection.tsx` — name = adjacent visible `Enabled` prop-label.
- `AssistantProjectJevSection.tsx` — name = `Jev advisory`.
- `assistant/AssistantWriteToolsSection.tsx` — name = `Write tools enabled`.
- `chat/AssistantChatShell.tsx` pin — constant `Pin thread`.
- `ui/PasswordField.tsx` — constant `Show password`.
- `wiki/PageSettingsPanel.tsx` — `role="switch"`/`aria-checked` → `aria-pressed` (`Autosave`).
- `kanban/BoardToolbar.tsx` — outer button labeled, glyph `aria-hidden`.
- `ui/Toggle.tsx` — normalize (unused; not adopted/deleted).
- Extra sweep find: `setup/SetupStepEmail.tsx` password toggle (same convention; `setup-wizard.html`).

## Acceptance
Touched tests green; `bun run test:app` green; `tsc --noEmit` clean; PR to `main`
referencing LX-13; do NOT merge.
