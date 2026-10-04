import { useId } from "react";

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: React.ReactNode;
  ariaLabel?: string;
  disabled?: boolean | undefined;
  className?: string | undefined;
}

export function Toggle({ checked, onChange, label, ariaLabel, disabled, className }: ToggleProps) {
  const labelId = useId();
  const labelledBy = !ariaLabel && label != null ? labelId : undefined;
  return (
    <div className={className}>
      <button
        type="button"
        className={`toggle-switch${checked ? " is-on" : ""}`}
        aria-pressed={checked}
        aria-label={ariaLabel}
        aria-labelledby={labelledBy}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      />
      {label != null && <span id={labelId} className="text-sm color-secondary">{label}</span>}
    </div>
  );
}
