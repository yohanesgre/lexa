// Create-issue confirmation. When the task's column maps to "closed", the
// created issue starts open and shows out of sync until the task moves to
// the mapped column — hence the extra warning variant.
export function GitHubCreateConfirmDialog({
  columnGithubState,
  selectedRepo,
  creating,
  onCreate,
  onCancel,
}: {
  columnGithubState: "open" | "closed" | null;
  selectedRepo: string;
  creating: boolean;
  onCreate: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <button type="button" className="dialog-overlay" onClick={onCancel} aria-label="Close" />
      <div className="fixed inset-0 flex items-center justify-center z-[70] pointer-events-none">
        <dialog open className="dialog dialog-enter" aria-modal="true" aria-labelledby="gh-create-title">
          {columnGithubState === "closed" ? (
            <>
              <h2 id="gh-create-title" className="font-display text-lg font-medium text-lx-text-primary">Create issue in a closed column?</h2>
              <p className="text-sm text-lx-text-secondary mt-3 leading-5" style={{ maxWidth: 360 }}>
                This task's column maps to <span className="font-mono text-xs">closed</span>. The new issue will start <span className="font-mono text-xs">open</span> and show out of sync until the task is moved to the mapped column.
              </p>
              <div className="flex items-center gap-2 mt-4 justify-end">
                <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
                <button type="button" className="btn btn-primary" onClick={onCreate} disabled={creating}>
                  {creating ? "Creating..." : "Create issue anyway"}
                </button>
              </div>
            </>
          ) : (
            <>
              <h2 id="gh-create-title" className="font-display text-lg font-medium text-lx-text-primary">Create GitHub issue in <span className="font-mono text-sm">{selectedRepo}</span> from this task?</h2>
              <p className="text-sm text-lx-text-secondary mt-3 leading-5" style={{ maxWidth: 360 }}>
                Creates a GitHub issue from this task and links it. Title + description are seeded from the task.
              </p>
              <div className="flex items-center gap-2 mt-4 justify-end">
                <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
                <button type="button" className="btn btn-primary" onClick={onCreate} disabled={creating}>
                  {creating ? "Creating..." : "Create issue"}
                </button>
              </div>
            </>
          )}
        </dialog>
      </div>
    </>
  );
}
