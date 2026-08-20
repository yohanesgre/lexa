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
        className={`toggle-switch${checked ? " is-on" : ""}`}
        aria-pressed={checked}
        aria-label={typeof label === "string" ? label : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      />
      {label != null && <span className="text-sm color-secondary">{label}</span>}
    </div>
  );
}
