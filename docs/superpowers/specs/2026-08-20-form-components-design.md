# Form Components — Design

Date: 2026-08-20
Status: Draft

## Context

The design system (`docs/design-system.html` §Inputs & Controls) defines bare
primitives — `.prop-input`, textarea, colored select, `.tasks-search`,
`.checkbox`, `.toggle-switch`, error = red border + `.notice notice-danger`.
The layout classes `.field`, `.field-label`, `.field-hint`,
`.field-hint-danger` already live in `phosphor.css` and the wireframes CSS.

In practice, ~25 files hand-compose the same form skeleton
(label + `prop-input` + hint/error) with `useState` + per-form error strings,
each with slight drift: some use `.field-hint-danger`, some `.notice
notice-danger`, some inline styles. There is no reusable form component layer,
no radio primitive, and no formal field-state (invalid/disabled) story.

## Goal

Ship a light composable form layer on top of the existing primitives.
No validation library, no form-state engine — plain `useState` +
`handleSubmit` stays (this preserves the earlier ruling against TanStack Form).

## Scope

- **New React components** in `app/components/ui/`:
  - `Field.tsx` — layout skeleton: label, control slot, hint, error.
  - `TextInput.tsx`, `TextArea.tsx`, `SelectInput.tsx`, `Checkbox.tsx`,
    `Toggle.tsx` — thin controlled controls.
  - Radio: **primitive only** (design system + wireframes). No React
    component until a real form needs it.
- **Design system doc update** (wireframe-first): add the composed field
  block and the radio primitive to `docs/design-system.html` and the
  mirrored `wireframes/src/design-system.html`, then `bash wireframes/build.sh`.
- **Migration** of the five forms with real validation:
  `CreateProjectModal`, `SetPasswordForm`, `MeSettings`, `TeamSettings`,
  `RuntimeSetupModal`. Bonus: `WorkspaceSettings` invite-link form.
- **Tests** for the new components.

Out of scope: validation libraries, form-state engines, TanStack Form,
changes to `SelectDropdown` (custom popover picker — stays as-is).

## Architecture

Single `<Field>` wrapper owning the layout skeleton, with a field context:

```tsx
<Field label="Name" hint="Slug is derived from the name." error={errors.name}>
  <TextInput value={name} onChange={setName} />
</Field>
```

- `Field` renders `.field` > `.field-label` + control + `.field-hint` (or
  `.field-hint-danger` on error).
- `Field` provides a `FieldContext` carrying `error` + `invalid`. Controls
  consume it to add the red border and `aria-invalid`.
- Controls accept an `invalid` prop override that wins over context, for
  standalone controls outside a `Field` (toolbar search, settings-row
  toggles). Otherwise standalone controls render without danger styling.
- `Field` is purely presentational — forms keep owning their own state.
- Accessibility: `Field` accepts `htmlFor` and controls forward `id`, wiring
  `label[for]` → control. When hint/error are present, the control gets
  `aria-describedby` pointing at the hint/error element.

## Data flow

Unchanged. Each form owns `useState<FormState>`, `handleSubmit`, and
per-field error strings. Components standardize rendering only.

## Error handling

- Per-field: `error` prop → `.field-hint-danger` + red border +
  `aria-invalid="true"`.
- Form-level: existing `.notice notice-danger` banner stays.
- Reuses `--lx-text-danger`, `--lx-border-focus` tokens. No new taxonomy.

## Components

| Component | Renders | Notes |
|---|---|---|
| `Field` | `.field` + `.field-label` + children + `.field-hint`/`-danger` | Provides `FieldContext` |
| `TextInput` | `<input class="prop-input w-full">` | Consumes context for invalid state |
| `TextArea` | `<textarea class="prop-input w-full">` | Same |
| `SelectInput` | `<select class="prop-input">` | Native select; matches colored-● pattern |
| `Checkbox` | `.checkbox` (+ `.checked`) in a `.check-row` | Wrapper for the existing primitive |
| `Toggle` | `<button class="toggle-switch">` | Refactor of the current inline button pattern |

All controls forward `value`/`onChange`/`disabled`/`placeholder`.

## Design system doc additions (wireframe-first)

Add to §Inputs & Controls in `docs/design-system.html` and
`wireframes/src/design-system.html`:

1. The **composed field block** as canonical form markup — `.field` +
   `.field-label` + `.prop-input` + `.field-hint`/`.field-hint-danger`, with
   copy-able code.
2. **Radio primitive** markup (new `.radio` class). No React component yet.
3. Error-state contract: invalid input gets red border + `aria-invalid`.

## Migration checklist

1. `CreateProjectModal` — name/team gating.
2. `SetPasswordForm` — length + confirm.
3. `MeSettings` — name/email/password.
4. `TeamSettings` — name/slug.
5. `RuntimeSetupModal` — machine/agent/key.
6. `WorkspaceSettings` — invite-link form (bonus).

## Testing

- `vitest` for components: `Field` renders label/hint/error and marks the
  control invalid via context; controls forward `value`/`onChange`/`disabled`;
  `invalid` override beats context.
- Follow existing `Dialogs.test.tsx` / `TaskPropertyBar.test.tsx` patterns.
- `tsc --noEmit` at the gate.
- Visual check via design system doc + migrated forms.

## File placement

- Components: `app/components/ui/`
- CSS: radio primitive added to `phosphor.css` + `wireframes/src/wireframes.css`
- Design system: `docs/design-system.html` + `wireframes/src/design-system.html`
- Wireframes rebuild: `bash wireframes/build.sh`

## Non-goals

- No validation library, form-state engine, or TanStack Form.
- No changes to `SelectDropdown`.
- No `Radio` React component yet.
- No migration of the remaining ~20 hand-composed forms (follow-up).
