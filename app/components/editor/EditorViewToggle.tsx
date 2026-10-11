import { cn } from "../ui/cn";

export type EditorView = "editor" | "preview";

// Both labels name what the pane shows: the editor (the rich-text surface the
// document is written in) and the rendered document. Markup is the design
// system's segmented control (`.tab-bar` / `.tab-btn` in docs/design-system.html).
export const EDITOR_VIEWS: { value: EditorView; label: string }[] = [
  { value: "editor", label: "Editor" },
  { value: "preview", label: "Preview" },
];

export function EditorViewToggle({
  view,
  onChange,
  className,
}: {
  view: EditorView;
  onChange: (view: EditorView) => void;
  className?: string | undefined;
}) {
  return (
    <div className={cn("editor-view-toggle", className)} role="group" aria-label="Document view">
      {EDITOR_VIEWS.map((option) => (
        <button
          key={option.value}
          type="button"
          className={cn("tab-btn", view === option.value && "active")}
          aria-pressed={view === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
