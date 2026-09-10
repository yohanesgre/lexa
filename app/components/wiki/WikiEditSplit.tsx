import type { Editor } from "@tiptap/core";
import { Download, Paperclip, Image as ImageIcon, X } from "lucide-react";
import type { TipTapDoc } from "../../../shared/types";
import { useDeleteAttachment, useSession, useWikiAttachments } from "../../lib/queries";
import { renderDoc } from "../tiptap-render";
import { WikiEditor } from "./WikiEditor";

function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isImageAttachment(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

// wireframes/src/wiki-edit.html: attachment chips carried by the page — label +
// count, download-only file chips, remove ✕ for the uploader or an admin.
function WikiAttachmentsSection({ slug, pageSlug }: { slug: string; pageSlug: string }) {
  const { data: attachments } = useWikiAttachments(slug, pageSlug);
  const remove = useDeleteAttachment(slug, "wiki", pageSlug);
  const { data: session } = useSession();
  const currentUserId = session?.session?.userId;
  const isAdmin = session?.user?.role === "superadmin";
  const rows = attachments ?? [];
  if (rows.length === 0) return null;

  return (
    <div style={{ padding: "8px 12px", borderTop: "1px solid var(--lx-border-subtle)" }}>
      <div className="flex items-center gap-2 mb-2">
        <Paperclip size={12} strokeWidth={1.5} className="text-lx-text-muted" />
        <span className="prop-label">Attachments</span>
        <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">{rows.length}</span>
      </div>
      <div className="flex items-center" style={{ gap: 6, flexWrap: "wrap" }}>
        {rows.map((a) => {
          const canRemove = isAdmin || (a.uploadedBy !== null && a.uploadedBy === currentUserId);
          return (
            <span
              key={a.id}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                height: 24,
                padding: "0 4px 0 8px",
                background: "var(--lx-surface-card)",
                border: "1px solid var(--lx-border-default)",
                borderRadius: 4,
                fontSize: 12,
                lineHeight: "16px",
                fontFamily: "var(--lx-font-body)",
                color: "var(--lx-text-primary)",
              }}
            >
              <span className="text-lx-text-muted inline-flex flex-shrink-0">
                {isImageAttachment(a.mimeType) ? (
                  <ImageIcon size={12} strokeWidth={1.5} />
                ) : (
                  <Download size={12} strokeWidth={1.5} />
                )}
              </span>
              <a
                href={`/api/attachments/${a.id}`}
                target="_blank"
                rel="noreferrer"
                style={{ color: "inherit", textDecoration: "none" }}
                title="Download"
              >
                {a.filename}
              </a>
              <span className="font-micro text-2xs text-lx-text-muted">{formatAttachmentSize(a.sizeBytes)}</span>
              {canRemove && (
                <button
                  type="button"
                  className="icon-btn"
                  style={{ width: 16, height: 16 }}
                  title="Remove attachment"
                  aria-label="Remove attachment"
                  disabled={remove.isPending}
                  onClick={() => {
                    void remove.mutateAsync(a.id).catch(() => {});
                  }}
                >
                  <X size={10} strokeWidth={2} />
                </button>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}


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
        <WikiAttachmentsSection slug={slug} pageSlug={pageSlug} />
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
