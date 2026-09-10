import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";

interface TaskPageBarProps {
  slug: string | undefined;
  project: { name: string } | null;
  onBack: () => void;
}

export function TaskPageBar({ slug, project, onBack }: TaskPageBarProps) {
  return (
    <div className="task-page-bar">
      <span className="text-xs font-body text-lx-text-muted">
        {slug ? (
          <>
            <Link to="/$slug/board" params={{ slug }} search={{}} className="text-lx-text-muted hover:text-lx-text-secondary">
              {project?.name ?? slug}
            </Link>
            {" / "}
            <Link to="/$slug/tasks" params={{ slug }} search={{}} className="text-lx-text-muted hover:text-lx-text-secondary">
              Tasks
            </Link>
          </>
        ) : (
          "Tasks"
        )}
      </span>
      <button type="button" className="btn btn-ghost !w-8 !h-8 !p-0" onClick={onBack} aria-label="Back" title="Back">
        <ArrowLeft size={18} strokeWidth={1.5} />
      </button>
    </div>
  );
}
