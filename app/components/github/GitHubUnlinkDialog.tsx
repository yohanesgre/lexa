import type { GithubIssue } from "../../../shared/types";

// Unlink confirmation: removes only the Lexa↔GitHub link; the issue itself
// stays open on GitHub.
export function GitHubUnlinkDialog({
  issue,
  onConfirm,
  onCancel,
}: {
  issue: GithubIssue;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <button type="button" className="dialog-overlay" onClick={onCancel} aria-label="Close" />
      <div className="fixed inset-0 flex items-center justify-center z-[70] pointer-events-none">
        <dialog open className="dialog dialog-enter" aria-modal="true" aria-labelledby="gh-unlink-title">
          <h2 id="gh-unlink-title" className="font-display text-lg font-medium text-lx-text-primary">Unlink issue?</h2>
          <p className="text-sm text-lx-text-secondary mt-3 leading-5" style={{ maxWidth: 360 }}>
            Unlink <span className="font-mono text-xs">{issue.repo} #{issue.issueNumber}</span> from this task? The GitHub issue stays open; only the link is removed.
          </p>
          <div className="flex items-center gap-2 mt-4 justify-end">
            <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
            <button type="button" className="btn btn-danger-solid" onClick={onConfirm}>Unlink</button>
          </div>
        </dialog>
      </div>
    </>
  );
}
