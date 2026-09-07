import { GithubMark, LinkIcon } from "../icons";

// Empty state when the task has no linked issue and the flow panel is
// closed: "No issue linked" row + Link issue button.
export function GitHubEmptyState({ onOpenFlow }: { onOpenFlow: () => void }) {
  return (
    <>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <GithubMark size={14} className="text-lx-text-muted" />
          <span className="text-sm text-lx-text-muted font-body">No issue linked</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="sync-dot sync-unlinked" />
          <span className="font-micro text-2xs uppercase tracking-[0.04em] text-lx-text-muted">
            Unlinked
          </span>
        </div>
      </div>
      <div className="mt-3">
        <button type="button" className="btn btn-ghost" onClick={onOpenFlow}>
          <LinkIcon size={14} />
          Link issue
        </button>
      </div>
    </>
  );
}
