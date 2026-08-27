import { createContext, useContext, useId } from "react";

export interface FieldContextValue {
  error: React.ReactNode;
  invalid: boolean;
  descId: string | undefined;
}

const FieldContext = createContext<FieldContextValue | null>(null);

export function useFieldContext(): FieldContextValue {
  // Safe default outside a Field so standalone controls can pass `invalid`
  // directly (human ruling: context defaults, no throw).
  return useContext(FieldContext) ?? { error: undefined, invalid: false, descId: undefined };
}

export interface FieldProps {
  label?: React.ReactNode;
  htmlFor?: string | undefined;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  children: React.ReactNode;
  className?: string | undefined;
}

export function Field({ label, htmlFor, hint, error, children, className }: FieldProps) {
  // useId must be called unconditionally (hooks rules); only pass it down when a desc element renders.
  const id = useId();
  const invalid = error != null && error !== "" && error !== false;
  const descId = invalid || (hint != null && hint !== "") ? id : undefined;
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
