import { Link } from "@tanstack/react-router";
import { X } from "lucide-react";

interface SlideoverHeaderProps {
  slug: string | undefined;
  project: { name: string } | null;
  isCreate: boolean;
  onExpand: (() => void) | undefined;
  onClose: () => void;
}

export function SlideoverHeader({ slug, project, isCreate, onExpand, onClose }: SlideoverHeaderProps) {
  return (
<div className="slideover-header border-b border-lx-border-subtle">
  {isCreate ? (
    <span className="text-xs font-body text-lx-text-muted">
      {slug ? (
        <>
          <Link to="/$slug/board" params={{ slug }} search={{}} className="text-lx-text-muted hover:text-lx-text-secondary">
            {project?.name ?? slug}
          </Link>
          {" / Board / "}
        </>
      ) : (
        "Board / "
      )}
      <span className="text-lx-text-secondary font-medium">New task</span>
    </span>
  ) : (
    <span className="text-xs font-body text-lx-text-muted">
      {slug ? (
        <>
          <Link to="/$slug/board" params={{ slug }} search={{}} className="text-lx-text-muted hover:text-lx-text-secondary">
            {project?.name ?? slug}
          </Link>
          {" / Board"}
        </>
      ) : (
        "Board"
      )}
    </span>
  )}
  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
    {!isCreate && onExpand && (
      <button type="button"
        className="btn btn-ghost !w-8 !h-8 !p-0"
        onClick={onExpand}
        aria-label="Open full page"
        title="Open full page"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
        </svg>
      </button>
    )}
    <button type="button" className="btn btn-ghost !w-8 !h-8 !p-0" onClick={onClose} aria-label="Close">
      <X size={18} strokeWidth={1.5} />
    </button>
  </div>
</div>
  );
}
