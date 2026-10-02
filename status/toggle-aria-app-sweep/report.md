# toggle-aria-app-sweep — report (LX-13 part 2)

## What changed
App toggles now follow the merged aria convention (constant name + `aria-pressed`).

| File | Before | After |
|---|---|---|
| `app/components/settings/AssistantSortableModelRow.tsx:33` | `aria-label={enabled ? "Enabled" : "Disabled"}`, no `aria-pressed` | `aria-label={mid}` (Model ID cell value), `aria-pressed={model.enabled}` |
| `app/components/settings/AssistantMcpSection.tsx:171` | `${label} enabled/disabled` | `aria-label={server.label}` |
| `app/components/settings/AssistantProjectMcpSection.tsx:65` | `${label} … for this project` | `aria-label={server.label}` |
| `app/components/settings/AssistantJevSection.tsx:113` | `Jev enabled/disabled` | `aria-label="Enabled"` (adjacent `prop-label`) |
| `app/components/settings/AssistantProjectJevSection.tsx:44` | `Jev advisory enabled/disabled/unavailable` | `aria-label="Jev advisory"` |
| `app/components/settings/assistant/AssistantWriteToolsSection.tsx:67` | `Write tools on` | `aria-label="Write tools enabled"` |
| `app/components/chat/AssistantChatShell.tsx:216` | `Unpin/Pin thread` | `aria-label="Pin thread"` (title stays state-varying) |
| `app/components/ui/PasswordField.tsx:26` | `Hide/Show password` | `aria-label="Show password"` (title stays state-varying) |
| `app/components/wiki/PageSettingsPanel.tsx:201` | `role="switch"` + `aria-checked` | `aria-pressed={autosaveEnabled}`, `aria-label="Autosave"` |
| `app/components/kanban/BoardToolbar.tsx:24-32` | no `aria-pressed`, glyph not hidden | `aria-pressed={showArchived}` on outer button, glyph `aria-hidden="true"` |
| `app/components/ui/Toggle.tsx` | string-only name | optional `ariaLabel` escape hatch; `aria-label={ariaLabel ?? (typeof label === "string" ? label : undefined)}`; `aria-pressed` unchanged (unused component, not adopted/deleted) |
| `app/components/setup/SetupStepEmail.tsx:94` | `Hide/Show password`, no `aria-pressed` | `aria-label="Show password"` + `aria-pressed={showPassword}` (extra sweep find; matches `wireframes/src/setup-wizard.html`) |

## Tests
- Updated name assertions: `AssistantProjectJevSection.test.tsx` (67, 74, 84, 94, 107 → `Jev advisory`); `AssistantJevSection.test.tsx:119` (→ `Enabled`); `AssistantMcpSection.test.tsx:512` (→ `Linear`); `AssistantProjectMcpSection.test.tsx` (77, 81, 87, 93 → `Notion`/`Linear`); `AssistantWriteToolsSection.test.tsx:95` (→ `Write tools enabled`); `chat-header.test.tsx:47-48` (→ `Pin thread`); `PageSettingsPanel.test.tsx:80-81` (`role="button"` + `aria-pressed`).
- Added pressed-state assertions (constant name, `aria-pressed` flips): write-tools master in `AssistantWriteToolsSection.test.tsx`; new `AssistantSortableModelRow.test.tsx`.

### Output
Touched test files:
```
Test Files  8 passed (8)
Tests       97 passed (97)
```
`bun run test:app`:
```
Test Files  95 passed (95)
Tests       815 passed (815)
```
`bash scripts/verify-gate.sh` (lane `fe`, tsc + `vitest run shared app` + secrets):
```
✓ typecheck passed
Test Files  104 passed (104)
Tests       984 passed (984)
✓ tests passed (fe)
✓ no secrets staged
Gate GREEN — safe to commit.
```

## Final grep sweep — leftovers
- `role="switch"`: none remain in `app/`.
- `aria-checked`: only correct non-toggle usages — `setup/SetupStepSeed.tsx:58` (`role="radio"`), `tasks/TasksPage.tsx:181` (checkbox select-all), `ui/Checkbox.tsx:15` (checkbox). Out of the toggle convention.
- State-varying `aria-label` on `aria-pressed` controls: none remain. The remaining state-varying labels are on controls WITHOUT `aria-pressed` (disclosure/menu/copy buttons: `kanban/SwimlaneHeader.tsx`, `kanban/TaskCard.tsx`, `layout/AppShell.tsx`, `layout/ThemeToggle.tsx`, `wiki/WikiTreeItem.tsx`, `milestones/MilestonesPage.tsx`, `chat/assistant-chat-icons.tsx`, `TextEditor.tsx`, `chat/AssistantApprovals.tsx`, `settings/TeamSettings.tsx`). The merged convention scopes itself to `<button aria-pressed>`; these are not toggles and are unmapped — reported, not changed.

## Deviations
- No wireframe had a counterpart for the generic unused `ui/Toggle.tsx` (caller supplies the name); normalized internally, no name invented.
- No commits beyond this lane; merge is out of scope (brief: do NOT merge).
