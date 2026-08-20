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
