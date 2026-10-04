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
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

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

  // Roving focus: opening lands on the selected option; arrow keys move focus.
  useEffect(() => {
    if (!open) return;
    const selected = options.findIndex((option) => option.value === value);
    setActiveIndex(selected >= 0 ? selected : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on open only
  }, [open]);

  useEffect(() => {
    if (!open) return;
    optionRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  const toggle = () => setOpen((v) => !v);

  const handleListKeyDown = (event: React.KeyboardEvent) => {
    if (options.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((i) => (i + 1) % options.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((i) => (i - 1 + options.length) % options.length);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(options.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const option = options[activeIndex];
      if (option) {
        onChange(option.value);
        setOpen(false);
      }
    }
  };

  return (
    <div ref={containerRef} className="relative inline-flex">
      {trigger({ open, toggle })}
      {open && (
        <div className={cn("menu-popover", "left")} role="listbox" onKeyDown={handleListKeyDown}>
          {options.map((option, index) => {
            const selected = option.value === value;
            return (
              <button
                key={option.value}
                ref={(el) => { optionRefs.current[index] = el; }}
                type="button"
                role="option"
                aria-selected={selected}
                tabIndex={-1}
                className={cn("menu-item", selected && "active")}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                {selected && <Check size={14} strokeWidth={2} />}
                {option.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
