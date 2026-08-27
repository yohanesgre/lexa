import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { cn } from "./ui/cn";

interface AssigneeChipsProps {
  assignees: string[];
  availableAssignees: string[];
  placeholder?: string | undefined;
  inputClassName?: string | undefined;
  inputStyle?: React.CSSProperties;
  onChange?: (assignees: string[]) => void;
  readonly?: boolean | undefined;
  compact?: boolean | undefined;
  expanded?: boolean | undefined;
}

export function AssigneeChips({
  assignees,
  availableAssignees,
  placeholder,
  inputClassName,
  inputStyle,
  onChange,
  readonly,
  compact,
  expanded = false,
}: AssigneeChipsProps) {
  const [localExpanded, setLocalExpanded] = useState(false);
  const isExpanded = expanded || localExpanded;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
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

  const assigneesSet = new Set(assignees);
  const suggestions = availableAssignees.filter(
    (a) => !assigneesSet.has(a) && (!draft || a.toLowerCase().includes(draft.toLowerCase()))
  );

  const handleAdd = (name: string) => {
    onChange?.([...assignees, name]);
    setDraft("");
    setOpen(false);
  };

  const handleRemove = (name: string) => {
    onChange?.(assignees.filter((a) => a !== name));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && draft.trim() && !assignees.includes(draft.trim())) {
      e.preventDefault();
      handleAdd(draft.trim());
    }
  };

  if (readonly) {
    const visible = compact && !isExpanded ? assignees.slice(0, 3) : assignees;
    const overflow = compact && !isExpanded ? assignees.length - 3 : 0;
    return (
      <>
        {visible.map((a) => (
          <span key={a} className="assignee-chip">
            <span className="avatar">{a.slice(0, 2).toUpperCase()}</span>
            <span className="text-sm text-lx-text-primary font-medium">{a}</span>
          </span>
        ))}
        {overflow > 0 && (
          <button
            type="button"
            className="assignee-chip"
            style={{ opacity: 0.6, cursor: "pointer", border: "none", background: "none", font: "inherit" }}
            onClick={() => setLocalExpanded(true)}
            title="Show all assignees"
          >
            <span className="avatar">+{overflow}</span>
          </button>
        )}
        {compact && isExpanded && (
          <button
            type="button"
            className="assignee-chip"
            style={{ opacity: 0.6, cursor: "pointer", border: "none", background: "none", font: "inherit" }}
            onClick={() => setLocalExpanded(false)}
            title="Collapse"
          >
            <span className="avatar" style={{ fontSize: 10 }}>-</span>
          </button>
        )}
      </>
    );
  }

  return (
    <>
      <input
        className={inputClassName}
        style={inputStyle}
        value={draft}
        placeholder={placeholder}
        onFocus={() => {
          if (availableAssignees.length > 0) setOpen(true);
        }}
        onChange={(e) => {
          setDraft(e.target.value);
          if (!open && availableAssignees.length > 0) setOpen(true);
        }}
        onKeyDown={handleKeyDown}
        onBlur={(e) => {
          const related = e.relatedTarget as Node | null;
          if (containerRef.current && related && containerRef.current.contains(related)) {
            return;
          }
          if (draft.trim() && !assignees.includes(draft.trim())) {
            handleAdd(draft.trim());
          }
        }}
      />
      {assignees.map((a) => (
        <span key={a} className="assignee-chip">
          <span className="avatar">{a.slice(0, 2).toUpperCase()}</span>
          <span className="text-sm text-lx-text-primary font-medium">{a}</span>
          <button type="button" className="assignee-chip-x" aria-label={`Remove assignee ${a}`} onClick={() => handleRemove(a)}>
            <X size={10} strokeWidth={2} />
          </button>
        </span>
      ))}
      {open && suggestions.length > 0 && (
        <div className="dropdown-menu" style={{ position: "absolute", top: "100%", left: 0, zIndex: 60 }}>
          <div className="dropdown-label">Members</div>
          {suggestions.map((name) => (
            <button
              key={name}
              type="button"
              className={cn("dropdown-item", assigneesSet.has(name) && "active")}
              onClick={() => handleAdd(name)}
            >
              <span className="avatar">{name.slice(0, 2).toUpperCase()}</span>
              <div>
                <div className="text-sm font-medium text-lx-text-primary">{name}</div>
                <div className="font-mono text-2xs text-lx-text-muted">{name.toLowerCase()}@example.com</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
