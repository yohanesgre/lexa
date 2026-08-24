import type { Editor } from "@tiptap/core";
import type { TipTapDoc } from "../../../shared/types";
import { renderDoc } from "../tiptap-render";
import { WikiEditor } from "./WikiEditor";

interface WikiEditSplitProps {
  editor: Editor | null;
  slug: string;
  pageSlug: string;
  previewContent: TipTapDoc;
  isSaving: boolean;
  isDirty: boolean;
  lastSavedAt: Date | null;
  lastSavedLabel: string;
  onReviewStateChange: (active: boolean, accepted: boolean) => void;
}

export function WikiEditSplit({ editor, slug, pageSlug, previewContent, isSaving, isDirty, lastSavedAt, lastSavedLabel, onReviewStateChange }: WikiEditSplitProps) {
  return (
    <div className="flex flex-1 overflow-hidden" style={{ borderTop: "1px solid var(--lx-border-subtle)" }}>
      {/* Left: Preview */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <div
          style={{
            padding: "4px 8px",
            borderBottom: "1px solid var(--lx-border-subtle)",
            background: "var(--lx-bg-surface)",
          }}
        >
          <span className="text-xs text-lx-text-muted font-body uppercase tracking-[0.05em]">Preview</span>
        </div>
        <div
          className="wiki-prose flex-1 overflow-y-auto"
          style={{ padding: "16px 20px", background: "var(--lx-bg-page)" }}
        >
          {renderDoc(previewContent, "wiki", slug)}
        </div>
      </div>

      {/* Right: Editor */}
      <div
        className="flex flex-1 flex-col overflow-hidden"
        style={{ borderLeft: "1px solid var(--lx-border-subtle)" }}
      >
        <div
          style={{
            padding: "4px 8px",
            borderBottom: "1px solid var(--lx-border-subtle)",
            background: "var(--lx-bg-surface)",
          }}
        >
          <span className="text-xs text-lx-text-muted font-body uppercase tracking-[0.05em]">Editor</span>
        </div>
        {editor && <WikiEditor editor={editor} hearth={{ slug, documentType: "wiki", documentId: pageSlug }} onReviewStateChange={onReviewStateChange} />}
        <div
          className="flex items-center justify-between"
          style={{
            padding: "8px 12px",
            borderTop: "1px solid var(--lx-border-subtle)",
            background: "var(--lx-bg-surface)",
          }}
        >
          <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">
            {lastSavedLabel}
          </span>
          {isSaving ? (
            <span className="font-micro text-2xs text-lx-text-warning uppercase tracking-[0.04em]">Saving…</span>
          ) : (
            isDirty && (
              <span className="font-micro text-2xs text-lx-text-warning uppercase tracking-[0.04em]">
                Unsaved changes
              </span>
            )
          )}
        </div>
      </div>
    </div>
  );
}
