import { useRef } from "react";
import { useOverlayFocusTrap } from "../../lib/sidebar-state";
import type { AssistantWriteDiff } from "../../../shared/assistant";
import { DiffBody } from "./AssistantDiffBody";
import { targetFor } from "./assistant-diff-utils";

// The write detail sidebar. The approval chip has to fit the transcript column,
// so it stays terse — this is where the generated content is actually read: the
// full body of a create, the unified diff of an edit. It follows the active
// approval carousel card and defaults to the newest proposal until selected.
//
// Two layouts, one element (antislop-layoutmobile: mobile is its own state):
//  - ≥1280px  an in-flow right column beside the chat column.
//  - <1280px  a right drawer over the chat, opened by the header toggle, with a
//             full-height backdrop that closes it (mirrors the threads/wiki
//             panes' drawer, which is the app's established mobile pattern).
// The backdrop is a real button so it is reachable by touch and keyboard, not a
// hover-only affordance. PHOSPHOR tokens only — it reuses the approval
// primitives and the shared diff renderer, and adds no new vocabulary.
export function AssistantGeneratedPanel({ chip, overlayActive, loading, readError, onClose }: { chip: { diff: AssistantWriteDiff } | null; overlayActive: boolean; loading: boolean; readError: boolean; onClose: () => void }) {
  const panelRef = useRef<HTMLElement>(null);
  useOverlayFocusTrap(overlayActive, panelRef);
  return (
    <>
      <button type="button" className="chat-detail-backdrop" aria-label="Close generated content" onClick={onClose} />
      <aside ref={panelRef} id="generated-content-pane" className="chat-detail" aria-label="Generated content" role={overlayActive ? "dialog" : undefined} aria-modal={overlayActive || undefined} tabIndex={-1}>
        <div className="chat-detail-head">
          <span className="approval-blocklabel">Generated content</span>
          {chip ? <span className="approval-target">{targetFor(chip.diff)}</span> : null}
        </div>
        {chip ? (
          <div className="chat-detail-body" tabIndex={0} aria-label="Selected full diff">
            <DiffBody chip={chip} variant="panel" />
          </div>
        ) : (
          <div className="chat-detail-void">
            <span className="chat-detail-void-title">{loading ? "Loading generated content…" : readError ? "Generated content unavailable" : "Nothing generated yet"}</span>
            <span className="chat-detail-void-sub">{readError ? "Retry conversation history to load proposed changes." : loading ? "Reading this conversation." : "Writes the assistant proposes will appear here."}</span>
          </div>
        )}
      </aside>
    </>
  );
}
