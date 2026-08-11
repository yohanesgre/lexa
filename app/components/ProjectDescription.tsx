import { MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "./ui/cn";

interface ProjectDescriptionProps {
  description: string;
  onSettings: () => void;
}

export function ProjectDescription({ description, onSettings }: ProjectDescriptionProps) {
  const text = description.trim();
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);

  // New description (settings save) → collapse again and re-measure.
  useEffect(() => {
    setExpanded(false);
    setOverflows(false);
  }, [text]);

  useEffect(() => {
    if (expanded) return;
    const el = ref.current;
    if (el) setOverflows(el.scrollHeight > el.clientHeight);
  }, [text, expanded]);

  if (!text) {
    return (
      <div className="mb-4">
        <div className="bg-lx-surface-card border border-lx-border-default rounded-xl p-4">
          <div className="flex items-center justify-between mb-2.5">
            <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">About this project</span>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ width: 28, height: 28, padding: 0 }}
              aria-label="Project settings"
              title="Project settings"
              onClick={onSettings}
            >
              <MoreHorizontal size={16} strokeWidth={1.5} />
            </button>
          </div>
          <p className="text-sm text-lx-text-muted leading-5">No description yet</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-4">
      <div className="bg-lx-surface-card border border-lx-border-default rounded-xl p-4">
        <div className="flex items-center justify-between mb-2.5">
          <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">About this project</span>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ width: 28, height: 28, padding: 0 }}
            aria-label="Project settings"
            title="Project settings"
            onClick={onSettings}
          >
            <MoreHorizontal size={16} strokeWidth={1.5} />
          </button>
        </div>
        <p
          ref={ref}
          className={cn("text-sm text-lx-text-secondary leading-5", !expanded && "line-clamp-3")}
        >
          {text}
        </p>
        {(expanded || overflows) && (
          <div className="mt-1.5">
            <button type="button" className="swimlane-desc-more" onClick={() => setExpanded((e) => !e)}>
              {expanded ? "Read less" : "Read more"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
