import { useFieldContext } from "./Field";

export interface TextAreaProps
  extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange"> {
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean | undefined;
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
