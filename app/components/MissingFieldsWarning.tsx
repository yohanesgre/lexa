import { X } from "lucide-react";

function joinFieldLabels(fields: string[]): string {
  if (fields.length <= 1) return fields[0] ?? "";
  if (fields.length === 2) return `${fields[0]} and ${fields[1]}`;
  return `${fields.slice(0, -1).join(", ")}, and ${fields[fields.length - 1]}`;
}

export function MissingFieldsWarning({ columnName, fields, onDismiss }: { columnName: string | null; fields: string[]; onDismiss: () => void }) {
  return (
  <div className="px-4 pt-3">
    <div className="banner-warning">
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        style={{ flexShrink: 0 }}
      >
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01" />
      </svg>
      <span className="font-medium">{columnName} requires {joinFieldLabels(fields)}</span>
      <button
        type="button"
        className="banner-warning-dismiss"
        onClick={() => onDismiss()}
        aria-label="Dismiss warning"
      >
        <X size={14} strokeWidth={1.5} />
      </button>
    </div>
  </div>
  );
}
