import { Download, Paperclip, Image as ImageIcon, X } from "lucide-react";
import { useDeleteAttachment, useSession, useWikiAttachments } from "../../lib/queries";
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
    <div style={{ padding: "8px var(--lx-space-6)" }}>
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
  source: string;
  sourceIdentity: string;
  slug: string;
  pageSlug: string;
  editable: boolean;
  onSourceChange: (source: string) => void;
  isSaving: boolean;
  isDirty: boolean;
  lastSavedLabel: string;
  updatedByName: string | null;
  onReviewStateChange: (active: boolean, accepted: boolean) => void;
}

// The page's editing lane: one source editor with a toolbar Editor/Preview
// toggle, attachment chips and save status.
export function WikiEditSplit({ source, sourceIdentity, slug, pageSlug, editable, onSourceChange, isSaving, isDirty, lastSavedLabel, updatedByName, onReviewStateChange }: WikiEditSplitProps) {
  return (
    <div className="editor-pane flex flex-1 flex-col overflow-hidden">
      <div className="flex flex-1 flex-col overflow-hidden">
        <WikiEditor
          key={sourceIdentity}
          source={source}
          sourceIdentity={sourceIdentity}
          editable={editable}
          onSourceChange={onSourceChange}
          runtime={{ slug, documentType: "wiki", documentId: pageSlug }}
          onReviewStateChange={onReviewStateChange}
        />
      </div>
      <WikiAttachmentsSection slug={slug} pageSlug={pageSlug} />
      <div
        className="flex items-center justify-between"
        style={{
          padding: "8px var(--lx-space-6)",
          borderTop: "1px solid var(--lx-border-subtle)",
          background: "var(--lx-surface-elevated)",
        }}
      >
        <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">
          {isDirty ? null : (
            <>
              {lastSavedLabel}
              {!isSaving && updatedByName ? ` by ${updatedByName}` : ""}
            </>
          )}
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
  );
}
