import type { AssistantWriteDiff } from "../../../shared/assistant";
import { DiffBody } from "./AssistantDiffBody";
import { targetFor } from "./assistant-diff-utils";

// The write detail sidebar. The approval chip has to fit the transcript column,
// so it stays terse — this is where the generated content is actually read: the
// full body of a create, the unified diff of an edit. It follows the newest
// write of the current turn on its own (no click), and falls back to a void when
// the turn has proposed nothing.
//
// Two layouts, one element (antislop-layoutmobile: mobile is its own state):
//  - ≥1280px  an in-flow right column beside the chat column.
//  - <1280px  a right drawer over the chat, opened by the header toggle, with a
//             full-height backdrop that closes it (mirrors the threads/wiki
//             panes' drawer, which is the app's established mobile pattern).
// The backdrop is a real button so it is reachable by touch and keyboard, not a
// hover-only affordance. PHOSPHOR tokens only — it reuses the approval
// primitives and the shared diff renderer, and adds no new vocabulary.
export function AssistantGeneratedPanel({ chip, onClose }: { chip: { diff: AssistantWriteDiff } | null; onClose: () => void }) {
  return (
    <>
      <button type="button" className="chat-detail-backdrop" aria-label="Close generated content" onClick={onClose} />
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
    </>
  );
}
