# Form Components Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a light composable form layer (Field + controls) on top of the existing design system primitives, update the design system docs, and migrate the five forms with real validation.

**Architecture:** A single `<Field>` wrapper renders the `.field` + `.field-label` + control + `.field-hint`/`.field-hint-danger` skeleton and provides a `FieldContext` carrying the error state. Thin controlled controls (`TextInput`, `TextArea`, `SelectInput`, `Checkbox`, `Toggle`) consume the context to apply the red danger border + `aria-invalid`. An `invalid` prop on controls overrides context (for standalone use). No validation library, no form-state engine — forms keep their `useState<FormState>` + `handleSubmit`.

**Tech Stack:** React 19, TypeScript strict, Vitest + Testing Library (jsdom), TanStack Start. Test command: `bun run vitest run` (aliases to `vitest run`). Type gate: `bun run tsc --noEmit` (alias `tsc --noEmit`).

## Global Constraints

- TypeScript strict. No `any` outside JSON-payload boundaries.
- No comments in code unless behavior is genuinely non-obvious.
- No commits unless the user explicitly asks.
- Wireframe-first: any new CSS/primitive goes into `wireframes/src/` + `docs/design-system.html` BEFORE app code. The app stylesheet `app/styles/phosphor.css` is updated only by porting wireframe classes.
- Copy primitive markup verbatim from `docs/design-system.html` / `wireframes/src/design-system.html` — never hand-write a primitive.
- Design tokens are CSS variables — no raw hex outside `phosphor.css`.
- Components live in `app/components/ui/` (matches existing `DatePicker`, `SelectDropdown`, `ModalStack`).
- Follow existing test patterns (`app/components/Dialogs.test.tsx`, `TaskPropertyBar.test.tsx`): `// @vitest-environment jsdom`, `@testing-library/jest-dom/vitest`, `render`/`screen`/`userEvent` from `@testing-library/react`.

---

### Task 1: Radio primitive in wireframes + design system docs

**Files:**
- Modify: `wireframes/src/wireframes.css`
- Modify: `wireframes/src/design-system.html`
- Modify: `docs/design-system.html`
- Modify: `app/styles/phosphor.css`

**Interfaces:**
- Produces: `.radio` CSS class (14px circle, border-strong, focus-border when checked, white dot `::after`), mirroring `.checkbox`. Used by later design-system doc readers; no React component consumes it yet.

- [ ] **Step 1: Add the `.radio` primitive to the wireframes stylesheet**

Append after the `.checkbox.checked::after` block in `wireframes/src/wireframes.css` (around line 2316):

```css
.radio {
  width: 14px;
  height: 14px;
  border: 1px solid var(--lx-border-strong);
  border-radius: 9999px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.radio.checked {
  background: var(--lx-border-focus);
  border-color: var(--lx-border-focus);
}

.radio.checked::after {
  content: "";
  width: 5px;
  height: 5px;
  border-radius: 9999px;
  background: var(--lx-text-inverse);
}
```

- [ ] **Step 2: Add the radio example to the wireframes design system page**

In `wireframes/src/design-system.html`, find the Inputs & Controls section (the checkbox/toggle block ending with `No .radio class exists — skipped`). Remove that line and add a radio state-row after the checkbox/toggle block, following the existing `state-row`/`state-label` pattern:

```html
<div class="state-row">
  <span class="state-label">Radio</span>
  <div class="check-row"><div class="radio checked"></div> Owner</div>
  <div class="check-row"><div class="radio"></div> Member</div>
</div>
```

- [ ] **Step 3: Rebuild the wireframes**

Run: `bash wireframes/build.sh`
Expected: exits 0, `wireframes/dist/` regenerated.

- [ ] **Step 4: Port the `.radio` class into the app stylesheet**

Append the same `.radio` block (verbatim from Step 1) to `app/styles/phosphor.css`, next to the existing `.checkbox` definitions (around line 1390 in the docs, but find the actual `.checkbox` block in `phosphor.css`).

- [ ] **Step 5: Mirror the radio example into `docs/design-system.html`**

In `docs/design-system.html` §Inputs & Controls, find the checkbox/toggle `block-shell` (line ~5374) whose token-contract line reads `Tokens: --lx-border-focus (checked/toggle on). No .radio class exists — skipped.` Change that line to `Tokens: --lx-border-focus (checked/toggle on). Radio ships as a design-system primitive only — no React component yet.` Then add a radio state-row inside that same block-shell, after the toggle row:

```html
<div class="state-row">
  <span class="state-label">Radio</span>
  <div class="check-row"><div class="radio checked"></div> Owner</div>
  <div class="check-row"><div class="radio"></div> Member</div>
</div>
```

- [ ] **Step 6: Commit**

```bash
git add wireframes/src/wireframes.css wireframes/src/design-system.html docs/design-system.html app/styles/phosphor.css
git commit -m "feat: radio primitive in design system"
```

---

### Task 2: Field + FieldContext + TextInput

**Files:**
- Create: `app/components/ui/Field.tsx`
- Create: `app/components/ui/Field.test.tsx`
- Create: `app/components/ui/TextInput.tsx`

**Interfaces:**
- Produces:
  - `export function Field(props: FieldProps): React.ReactElement` where `FieldProps = { label?: React.ReactNode; htmlFor?: string; hint?: React.ReactNode; error?: React.ReactNode; children: React.ReactNode; className?: string }`.
  - `export function useFieldContext(): { error: React.ReactNode; invalid: boolean }` — throws `Error("Field context missing")` outside a `Field`.
  - `export function TextInput(props: TextInputProps): React.ReactElement` where `TextInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange"> & { value: string; onChange: (value: string) => void }` — note the string `onChange` signature (not the DOM event) — plus an `invalid?: boolean` prop.
- Consumes: nothing yet.

- [ ] **Step 1: Write the failing test**

`app/components/ui/Field.test.tsx`:

```tsx
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Field } from "./Field";
import { TextInput } from "./TextInput";

describe("Field", () => {
  it("renders label, hint, and control", () => {
    render(
      <Field label="Name" hint="Shown on the dashboard.">
        <TextInput value="" onChange={() => {}} />
      </Field>
    );
    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(screen.getByText("Shown on the dashboard.")).toBeInTheDocument();
  });

  it("renders the error message and marks the control invalid", () => {
    render(
      <Field label="Name" error="Required">
        <TextInput value="" onChange={() => {}} />
      </Field>
    );
    expect(screen.getByText("Required")).toBeInTheDocument();
    const input = screen.getByRole("textbox");
    expect(input).toHaveAttribute("aria-invalid", "true");
  });

  it("wires label htmlFor to the control id", () => {
    render(
      <Field label="Name" htmlFor="my-name">
        <TextInput id="my-name" value="" onChange={() => {}} />
      </Field>
    );
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run vitest run app/components/ui/Field.test.tsx`
Expected: FAIL — `Field`/`TextInput` not exported.

- [ ] **Step 3: Implement Field with FieldContext**

`app/components/ui/Field.tsx`:

```tsx
import { createContext, useContext, useId } from "react";

export interface FieldContextValue {
  error: React.ReactNode;
  invalid: boolean;
  descId: string;
}

const FieldContext = createContext<FieldContextValue | null>(null);

export function useFieldContext(): FieldContextValue {
  const value = useContext(FieldContext);
  if (!value) throw new Error("Field context missing");
  return value;
}

export interface FieldProps {
  label?: React.ReactNode;
  htmlFor?: string;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export function Field({ label, htmlFor, hint, error, children, className }: FieldProps) {
  const descId = useId();
  const invalid = error != null && error !== "";
  return (
    <div className={className}>
      {label && (
        <label className="field-label" htmlFor={htmlFor}>
          {label}
        </label>
      )}
      <FieldContext.Provider value={{ error, invalid, descId }}>
        {children}
      </FieldContext.Provider>
      {invalid ? (
        <div id={descId} className="field-hint-danger">
          {error}
        </div>
      ) : hint != null && hint !== "" ? (
        <div id={descId} className="field-hint">
          {hint}
        </div>
      ) : null}
    </div>
  );
}
```

Note: `useId()` gives each Field's hint/error a unique `id`; controls reference it via `aria-describedby`. TextInput must receive the desc id through the context so multiple hinted Fields in one form don't collide. The FieldContext carries `{ error, invalid, descId }` — extend the context value type and the `useFieldContext` return type accordingly (`{ error: React.ReactNode; invalid: boolean; descId: string }`), and have TextInput use `field.descId` for `aria-describedby`.

- [ ] **Step 4: Implement TextInput**

`app/components/ui/TextInput.tsx`:

```tsx
import { useFieldContext } from "./Field";

export interface TextInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange"> {
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
}

export function TextInput({ value, onChange, invalid, className, ...rest }: TextInputProps) {
  const field = useFieldContext();
  const isInvalid = invalid ?? field.invalid;
  return (
    <input
      {...rest}
      className={`prop-input w-full ${className ?? ""}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-invalid={isInvalid || undefined}
      aria-describedby={field.descId}
      style={isInvalid ? { borderColor: "var(--lx-text-danger)" } : rest.style}
    />
  );
}
```

Note: `aria-describedby={field.descId}` always points at the Field's hint/error element (which always exists when inside a `Field`). For standalone use outside a `Field`, `useFieldContext` throws — so standalone usage must pass `invalid` and omit `aria-describedby` by rendering outside a Field (acceptable: the control just has no hint).

- [ ] **Step 5: Run test to verify it passes**

Run: `bun run vitest run app/components/ui/Field.test.tsx`
Expected: PASS (3 tests).

Note on `aria-describedby`: `Field` passes its unique `descId` through the context (`{ error, invalid, descId }`); controls read `field.descId`. The FieldContextValue type and `useFieldContext` return type must include `descId: string` — update the interface in `Field.tsx` (Task 2, Step 3) accordingly: `export interface FieldContextValue { error: React.ReactNode; invalid: boolean; descId: string }` and provide it in the provider value.

- [ ] **Step 6: Commit**

```bash
git add app/components/ui/Field.tsx app/components/ui/Field.test.tsx app/components/ui/TextInput.tsx
git commit -m "feat: Field wrapper with context and TextInput control"
```

---

### Task 3: TextArea, SelectInput, Checkbox, Toggle

**Files:**
- Create: `app/components/ui/TextArea.tsx`
- Create: `app/components/ui/SelectInput.tsx`
- Create: `app/components/ui/Checkbox.tsx`
- Create: `app/components/ui/Toggle.tsx`
- Create: `app/components/ui/Controls.test.tsx`

**Interfaces:**
- Consumes: `useFieldContext` from `./Field` (Task 2).
- Produces:
  - `export function TextArea(props: TextAreaProps)` where `TextAreaProps = Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange"> & { value: string; onChange: (value: string) => void; invalid?: boolean }`. Renders `<textarea className="prop-input w-full">`, `resize:vertical;min-height:80px` inline style, context-based invalid state.
  - `export function SelectInput(props: SelectInputProps)` where `SelectInputProps = Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "onChange" | "children"> & { value: string; onChange: (value: string) => void; invalid?: boolean; children: React.ReactNode }`. Renders `<select className="prop-input">` with context-based invalid state.
  - `export function Checkbox(props: CheckboxProps)` where `CheckboxProps = { checked: boolean; onChange: (checked: boolean) => void; label: React.ReactNode; disabled?: boolean; className?: string }`. Renders `<div className="check-row">` containing `<div className={checkbox + checked ? " checkbox checked" : " checkbox"}>` (a non-focusable div — matches the existing `.checkbox` primitive which has no button/interactive role in the design system) plus the label.
  - `export function Toggle(props: ToggleProps)` where `ToggleProps = { checked: boolean; onChange: (checked: boolean) => void; label?: React.ReactNode; disabled?: boolean; className?: string }`. Renders `<button type="button" className="toggle-switch" aria-pressed={checked}>` + optional label.

- [ ] **Step 1: Write the failing tests**

`app/components/ui/Controls.test.tsx`:

```tsx
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TextArea } from "./TextArea";
import { SelectInput } from "./SelectInput";
import { Checkbox } from "./Checkbox";
import { Toggle } from "./Toggle";

describe("TextArea", () => {
  it("forwards value and onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TextArea value="hello" onChange={onChange} />);
    const textbox = screen.getByRole("textbox");
    expect(textbox).toHaveValue("hello");
    await user.type(textbox, "x");
    expect(onChange).toHaveBeenCalledWith("hellox");
  });
});

describe("SelectInput", () => {
  it("forwards value and onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <SelectInput value="a" onChange={onChange}>
        <option value="a">A</option>
        <option value="b">B</option>
      </SelectInput>
    );
    await user.selectOptions(screen.getByRole("combobox"), "b");
    expect(onChange).toHaveBeenCalledWith("b");
  });
});

describe("Checkbox", () => {
  it("toggles checked state", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Checkbox checked={false} onChange={onChange} label="Description" />);
    await user.click(screen.getByText("Description"));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe("Toggle", () => {
  it("toggles aria-pressed and fires onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} label="Autosave" />);
    const toggle = screen.getByRole("button");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await user.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run vitest run app/components/ui/Controls.test.tsx`
Expected: FAIL — components not exported.

- [ ] **Step 3: Implement the four controls**

`app/components/ui/TextArea.tsx`:

```tsx
import { useFieldContext } from "./Field";

export interface TextAreaProps
  extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange"> {
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
}

export function TextArea({ value, onChange, invalid, className, ...rest }: TextAreaProps) {
  const field = useFieldContext();
  const isInvalid = invalid ?? field.invalid;
  return (
    <textarea
      {...rest}
      className={`prop-input w-full ${className ?? ""}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{ resize: "vertical", minHeight: 80, ...(isInvalid ? { borderColor: "var(--lx-text-danger)" } : {}), ...rest.style }}
      aria-invalid={isInvalid || undefined}
    />
  );
}
```

`app/components/ui/SelectInput.tsx`:

```tsx
import { useFieldContext } from "./Field";

export interface SelectInputProps
  extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "onChange" | "children"> {
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
  children: React.ReactNode;
}

export function SelectInput({ value, onChange, invalid, className, children, ...rest }: SelectInputProps) {
  const field = useFieldContext();
  const isInvalid = invalid ?? field.invalid;
  return (
    <select
      {...rest}
      className={`prop-input ${className ?? ""}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-invalid={isInvalid || undefined}
      style={isInvalid ? { borderColor: "var(--lx-text-danger)" } : rest.style}
    >
      {children}
    </select>
  );
}
```

`app/components/ui/Checkbox.tsx`:

```tsx
export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: React.ReactNode;
  disabled?: boolean;
  className?: string;
}

export function Checkbox({ checked, onChange, label, disabled, className }: CheckboxProps) {
  return (
    <div
      className={`check-row ${className ?? ""}`}
      onClick={() => !disabled && onChange(!checked)}
      role="checkbox"
      aria-checked={checked}
      tabIndex={disabled ? -1 : 0}
      onKeyDown={(e) => {
        if (!disabled && (e.key === " " || e.key === "Enter")) {
          e.preventDefault();
          onChange(!checked);
        }
      }}
    >
      <div className={checked ? "checkbox checked" : "checkbox"} />
      {label}
    </div>
  );
}
```

`app/components/ui/Toggle.tsx`:

```tsx
export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: React.ReactNode;
  disabled?: boolean;
  className?: string;
}

export function Toggle({ checked, onChange, label, disabled, className }: ToggleProps) {
  return (
    <div className={className}>
      <button
        type="button"
        className="toggle-switch"
        aria-pressed={checked}
        aria-label={typeof label === "string" ? label : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      />
      {label != null && <span className="text-sm color-secondary">{label}</span>}
    </div>
  );
}
```

Note: the existing `.toggle-switch` primitive in the design system is an unchecked-state button with no `aria-pressed`; adding `aria-pressed` is the accessible-state improvement this component standardizes (the design-system doc's own example uses `aria-label="Autosave off"`).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run vitest run app/components/ui/Controls.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `bun run tsc --noEmit`
Expected: exit 0, no errors.

- [ ] **Step 6: Commit**

```bash
git add app/components/ui/TextArea.tsx app/components/ui/SelectInput.tsx app/components/ui/Checkbox.tsx app/components/ui/Toggle.tsx app/components/ui/Controls.test.tsx
git commit -m "feat: TextArea, SelectInput, Checkbox, Toggle controls"
```

---

### Task 4: Migrate CreateProjectModal

**Files:**
- Modify: `app/components/CreateProjectModal.tsx`

**Interfaces:**
- Consumes: `Field`, `TextInput`, `TextArea`, `SelectInput` from `app/components/ui/`.
- Produces: nothing new — behavior identical, rendering uses the components.

- [ ] **Step 1: Read the current file and rewrite the three fields**

Replace the manual `div.field` + `label.field-label` + `input/textarea/select` blocks (lines ~54-96) with the component forms. Keep all existing state, gating, and handlers exactly:

```tsx
<Field label="Name" htmlFor="create-project-name" hint="Shown on the dashboard and in the nav. Slug is derived from the name.">
  <TextInput id="create-project-name" value={name} onChange={setName} autoFocus disabled={pending} />
</Field>

<Field label="Team" htmlFor="create-project-team" hint="The owning team scopes who can see and use the project. Unassigned (no team) is superadmin-only.">
  <SelectInput id="create-project-team" value={teamId} onChange={setTeamId} disabled={pending || teamsLoading} aria-label="Project team">
    <option value="">Select a team…</option>
    {teams.map((t) => (
      <option key={t.id} value={t.id}>{t.name} ({t.slug})</option>
    ))}
  </SelectInput>
</Field>

<Field label="Description" htmlFor="create-project-desc">
  <TextArea id="create-project-desc" value={desc} onChange={setDesc} rows={3} disabled={pending} />
</Field>
```

Wrap the three `Field`s in a container with `marginBottom: 16` between them (the existing inline `style={{ marginBottom: 16 }}` on the first two `.field` divs becomes `style={{ marginBottom: 16 }}` on a wrapper div, or `mb-3` on each Field's className).

- [ ] **Step 2: Update imports**

```tsx
import { Field, TextInput, TextArea, SelectInput } from "./ui";
```

(Verify whether `app/components/ui/index.ts` exists; if not, import from individual files: `import { Field } from "./ui/Field";` etc.)

- [ ] **Step 3: Remove the `useTeams`-driven team `<select>` remnants**

Confirm no leftover `label.field-label` or raw `prop-input` elements remain in this file.

- [ ] **Step 4: Typecheck + test**

Run: `bun run tsc --noEmit` then `bun run vitest run app/components/Dialogs.test.tsx`
Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add app/components/CreateProjectModal.tsx
git commit -m "refactor: CreateProjectModal uses form components"
```

---

### Task 5: Migrate SetPasswordForm

**Files:**
- Modify: `app/components/auth/SetPasswordForm.tsx`

**Interfaces:**
- Consumes: `Field`, `TextInput` from `app/components/ui/`.
- Produces: nothing new — same exports (`SetPasswordForm`, `InvalidTokenState`), same behavior.

- [ ] **Step 1: Rewrite the two password fields with Field + TextInput**

The password field's conditional hint (`tooShort ? danger : normal`, both branches identical text "At least 8 characters.") becomes `error={tooShort ? "At least 8 characters." : undefined}`. Confirm field keeps the identical text and behavior.

```tsx
<Field label="Password" htmlFor="sp-password" error={tooShort ? "At least 8 characters." : undefined}>
  <TextInput id="sp-password" type="password" placeholder="••••••••••••" autoComplete="new-password" value={password} onChange={(v) => { setPasswordValue(v); setConfirmError(null); }} />
</Field>

<Field label="Confirm password" htmlFor="sp-confirm" error={confirmError ?? undefined}>
  <TextInput id="sp-confirm" type="password" placeholder="••••••••••••" autoComplete="new-password" value={confirm} onChange={(v) => { setConfirm(v); setConfirmError(null); }} />
</Field>
```

- [ ] **Step 2: Update imports and verify behavior**

Import `Field`, `TextInput`. The form-level submit button, `canSubmit`, and success panel stay unchanged. Verify `confirmError` still clears on both input changes.

- [ ] **Step 3: Typecheck + test**

Run: `bun run tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add app/components/auth/SetPasswordForm.tsx
git commit -m "refactor: SetPasswordForm uses form components"
```

---

### Task 6: Migrate MeSettings

**Files:**
- Modify: `app/components/settings/MeSettings.tsx`

**Interfaces:**
- Consumes: `Field`, `TextInput` from `app/components/ui/`.
- Produces: nothing new — same exports, same behavior.

- [ ] **Step 1: Rewrite ProfileSection's name field**

```tsx
<Field label="Name" htmlFor="me-name" hint="Initials avatar derives from the name. Save → PATCH /api/me; the user-menu trigger updates from the response.">
  <TextInput id="me-name" value={name} onChange={(v) => { setName(v); if (error) setError(null); }} />
</Field>
```

- [ ] **Step 2: Rewrite ProfileSection's email field (read-only)**

Keep the read-only treatment (disabled + opacity) — use a plain `<input>` inside a `Field` (no `TextInput`, since `TextInput`'s string `onChange` requires `value`; the disabled input has no handler and `value={user.email}`). The `read-only` badge stays:

```tsx
<Field label="Email" htmlFor="me-email" hint="Email is the login identity — changing it is a provisioning-level action (contact your admin).">
  <div className="flex items-center gap-2">
    <input id="me-email" className="prop-input w-full" value={user.email} disabled style={{ opacity: 0.6 }} />
    <span className="text-xs text-lx-text-muted">read-only</span>
  </div>
</Field>
```

- [ ] **Step 3: Rewrite PasswordSection's three fields**

```tsx
<Field label="Current password" htmlFor="pw-current">
  <TextInput id="pw-current" type="password" placeholder="••••••••••••" autoComplete="current-password" value={current} onChange={(v) => { setCurrent(v); setError(null); }} />
</Field>

<Field label="New password" htmlFor="pw-new" error={tooShort ? "At least 8 characters." : undefined}>
  <TextInput id="pw-new" type="password" placeholder="••••••••••••" autoComplete="new-password" value={next} onChange={(v) => { setNext(v); setError(null); }} />
</Field>

<Field label="Confirm new password" htmlFor="pw-confirm">
  <TextInput id="pw-confirm" type="password" placeholder="••••••••••••" autoComplete="new-password" value={confirm} onChange={(v) => { setConfirm(v); setError(null); }} />
</Field>
```

- [ ] **Step 4: Preserve the form-level error + success hints**

The existing `{error && <div className="field-hint-danger mt-2">{error}</div>}` and success message stay exactly as-is below the fields (form-level, not per-field).

- [ ] **Step 5: Update imports, typecheck, commit**

Import `Field`, `TextInput`. Run `bun run tsc --noEmit` (exit 0). Commit:

```bash
git add app/components/settings/MeSettings.tsx
git commit -m "refactor: MeSettings uses form components"
```

---

### Task 7: Migrate TeamSettings

**Files:**
- Modify: `app/components/settings/TeamSettings.tsx`

**Interfaces:**
- Consumes: `Field`, `TextInput`, `SelectInput` from `app/components/ui/`.
- Produces: nothing new — same exports, same behavior.

- [ ] **Step 1: Rewrite TeamProfileSection's name + slug fields**

```tsx
<Field label="Name" htmlFor="team-profile-name">
  <TextInput id="team-profile-name" value={name} onChange={(v) => { setName(v); setSaved(false); }} style={{ minWidth: 220 }} />
</Field>
```

Note: the name field previously used `style={{ minWidth: 220 }}` with no `w-full`. `TextInput` always renders `prop-input w-full`; the `minWidth` carries via the forwarded `style` prop. The slug field stays a raw disabled `<input>` (read-only, no handler — `TextInput` requires `value` + `onChange`, and there's no change to make).

- [ ] **Step 2: Rewrite the add-member row**

The add-member email input + role select are a form row, not a labeled Field. Keep them as-is (they use `aria-label`, not `Field` labels) — this is a compact toolbar, not a form field. Only the role `<select>` could use `SelectInput`, but since it's a compact row with `style={{ height: 32, fontSize: 12, width: 96 }}` and no label, leave it as a raw select.

- [ ] **Step 3: Preserve form-level error/saved hints**

The existing `{error && <div className="field-hint-danger mt-2">{error}</div>}` and `{saved && ...}` stay unchanged.

- [ ] **Step 4: Update imports, typecheck, commit**

Import `Field`, `TextInput`. Run `bun run tsc --noEmit` (exit 0). Commit:

```bash
git add app/components/settings/TeamSettings.tsx
git commit -m "refactor: TeamSettings uses form components"
```

---

### Task 8: Migrate RuntimeSetupModal (StepKeySend key name)

**Files:**
- Modify: `app/components/forge/RuntimeSetupModal.tsx`

**Interfaces:**
- Consumes: `Field`, `TextInput` from `app/components/ui/`.
- Produces: nothing new — same exports, same behavior.

- [ ] **Step 1: Rewrite StepKeySend's key-name field**

The field uses `.prop-label` (uppercase) + `flex-1` input + trailing Create button. Replace the label + input with `Field` + `TextInput`, keeping the trailing button:

```tsx
<Field label="Key name" htmlFor="runtime-key-name" className="mb-4">
  <div className="flex gap-2">
    <TextInput id="runtime-key-name" value={newKeyName} onChange={onKeyNameChange} placeholder="e.g. forge-opencode" className="flex-1" onKeyDown={(event) => { if (event.key === "Enter") onCreateKey(); }} />
    <button type="button" className="btn btn-ghost" disabled={!newKeyName.trim() || createApiKey.isPending} onClick={onCreateKey}>
      {createApiKey.isPending ? <RefreshCw size={14} strokeWidth={1.5} className="animate-spin" /> : <Check size={14} strokeWidth={1.5} />} Create
    </button>
  </div>
</Field>
```

Note: the `onKeyDown` prop must still work — `TextInput` forwards `onKeyDown` via rest props.

- [ ] **Step 2: Check the StepMachine key-name field too**

`StepMachine` (line ~117-134) has a similar field (`machine-key-name`). If it's the same pattern (label + input + button), migrate it the same way; if it differs (e.g. different label styling), leave it and note the difference.

- [ ] **Step 3: Typecheck + commit**

Run: `bun run tsc --noEmit` (exit 0). Commit:

```bash
git add app/components/forge/RuntimeSetupModal.tsx
git commit -m "refactor: RuntimeSetupModal uses form components"
```

---

### Task 9: Migrate WorkspaceSettings invite-link form

**Files:**
- Modify: `app/components/settings/WorkspaceSettings.tsx`

**Interfaces:**
- Consumes: `Field`, `TextInput` from `app/components/ui/`.
- Produces: nothing new — same exports, same behavior.

- [ ] **Step 1: Read the invite-link form**

Around line 151-163 there's an email input with `className="prop-input"` and a `field-hint`. It's an unlabeled compact form (the email input has a placeholder). Migrate only if it has a label; if it's a bare input + hint, leave it as-is (no label → no Field).

- [ ] **Step 2: Typecheck + commit (only if Step 1 migrated anything)**

Run: `bun run tsc --noEmit` (exit 0). Commit:

```bash
git add app/components/settings/WorkspaceSettings.tsx
git commit -m "refactor: WorkspaceSettings invite form uses form components"
```

If Step 1 found nothing to migrate, skip this task's commit and mark it done (the form uses a bare input + hint, correctly not a `Field`).

---

### Task 10: Final verification

**Files:**
- None (verification only).

- [ ] **Step 1: Full typecheck**

Run: `bun run tsc --noEmit`
Expected: exit 0, no errors.

- [ ] **Step 2: Full test suite**

Run: `bun run vitest run`
Expected: all existing + new tests pass (`Field.test.tsx`, `Controls.test.tsx`, `Dialogs.test.tsx`, `TaskPropertyBar.test.tsx`, shared/ server/ cli/ tests).

- [ ] **Step 3: Visual smoke check of the design system doc**

Open `docs/design-system.html` in a browser and confirm the new radio state-row renders in §Inputs & Controls, and the existing text/textarea/select/checkbox/toggle blocks are unchanged.

- [ ] **Step 4: Wireframes rebuild gate**

Run: `bash wireframes/build.sh`
Expected: exits 0 (already run in Task 1; re-run to confirm clean state).

- [ ] **Step 5: Report**

Summarize: components shipped, docs updated, forms migrated (list each), tests green.
