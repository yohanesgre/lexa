import type { DiffResult } from "../../../shared/diff";

// Git-style unified diff renderer for Forge review-in-editor. Rendered below
// the review banner while the document stays untouched (see forge-review
// wireframe). PHOSPHOR tokens only.
export function DiffView({ diff }: { diff: DiffResult }) {
  if (diff.hunks.length === 0) {
    return (
      <div className="forge-diff-empty">
        No changes — the result is identical to the document. Accept does nothing.
      </div>
    );
  }

  return (
    <div className="forge-diff">
      {diff.hunks.map((hunk) => (
        <div className="forge-diff-hunk" key={`${hunk.oldStart}-${hunk.newStart}`}>
          <div className="forge-diff-hunk-header">
            @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
          </div>
          {hunk.lines.map((line, j) => (
            <div className={`forge-diff-line ${line.kind}`} key={j}>
              <span className="forge-diff-sign" aria-hidden="true">
                {line.kind === "del" ? "−" : "+"}
              </span>
              <span className="forge-diff-text">
                {line.spans.length > 0
                  ? line.spans.map((span, k) => (
                      <span className={`forge-diff-span ${span.kind}`} key={k}>
                        {span.text}
                      </span>
                    ))
                  : line.text}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
