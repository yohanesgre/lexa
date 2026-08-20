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
      aria-describedby={field.descId ?? rest["aria-describedby"]}
      style={isInvalid ? { borderColor: "var(--lx-text-danger)" } : rest.style}
    />
  );
}
