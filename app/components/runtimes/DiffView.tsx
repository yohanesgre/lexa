import type { DiffResult } from "../../../shared/diff";

// Git-style unified diff renderer for Runtime review-in-editor. Rendered below
// the review banner while the document stays untouched (see runtime-review
// wireframe). PHOSPHOR tokens only.
export function DiffView({ diff }: { diff: DiffResult }) {
  if (diff.hunks.length === 0) {
    return (
      <div className="runtime-diff-empty">
        No changes — the result is identical to the document. Accept does nothing.
      </div>
    );
  }

  return (
    <div className="runtime-diff">
      {diff.hunks.map((hunk) => (
        <div className="runtime-diff-hunk" key={`${hunk.oldStart}-${hunk.newStart}`}>
          <div className="runtime-diff-hunk-header">
            @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
          </div>
          {hunk.lines.map((line, j) => (
            <div className={`runtime-diff-line ${line.kind}`} key={j}>
              <span className="runtime-diff-sign" aria-hidden="true">
                {line.kind === "del" ? "−" : "+"}
              </span>
              <span className="runtime-diff-text">
                {line.spans.length > 0
                  ? line.spans.map((span, k) => (
                      <span className={`runtime-diff-span ${span.kind}`} key={k}>
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
