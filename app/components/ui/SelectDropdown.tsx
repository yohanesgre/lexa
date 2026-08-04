import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { cn } from "./cn";

interface SelectOption {
  value: string;
  label: React.ReactNode;
}

interface SelectDropdownProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  trigger: (props: { open: boolean; toggle: () => void }) => React.ReactNode;
}

export function SelectDropdown({ value, options, onChange, trigger }: SelectDropdownProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function handleMouseDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const toggle = () => setOpen((v) => !v);

  return (
    <div ref={containerRef} className="relative inline-flex">
      {trigger({ open, toggle })}
      {open && (
        <div className={cn("menu-popover", "left")}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              className={cn("menu-item", option.value === value && "active")}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              {option.value === value && <Check size={14} strokeWidth={2} />}
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
