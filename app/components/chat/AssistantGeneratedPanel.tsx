import type { AssistantWriteDiff } from "../../../shared/assistant";
import { DiffBody } from "./AssistantDiffBody";
import { targetFor } from "./assistant-diff-utils";

// The write detail sidebar. The approval chip has to fit the transcript column,
// so it stays terse — this is where the generated content is actually read: the
// full body of a create, the unified diff of an edit. It follows the newest
// write of the current turn on its own (no click), and falls back to a void when
// the turn has proposed nothing.
//
// Right column on wide viewports only; the CSS hides it below the breakpoint,
// where the chip remains the affordance. PHOSPHOR tokens only — it reuses the
// approval primitives and the shared diff renderer, and adds no new vocabulary.
export function AssistantGeneratedPanel({ chip }: { chip: { diff: AssistantWriteDiff } | null }) {
  return (
    <aside className="chat-detail" aria-label="Generated content">
      <div className="chat-detail-head">
        <span className="approval-blocklabel">Generated content</span>
        {chip ? <span className="approval-target">{targetFor(chip.diff)}</span> : null}
      </div>
      {chip ? (
        <div className="chat-detail-body">
          <DiffBody chip={chip} variant="panel" />
        </div>
      ) : (
        <div className="chat-detail-void">
          <span className="chat-detail-void-title">Nothing generated yet</span>
          <span className="chat-detail-void-sub">Writes the assistant proposes will appear here.</span>
        </div>
      )}
    </aside>
  );
}
