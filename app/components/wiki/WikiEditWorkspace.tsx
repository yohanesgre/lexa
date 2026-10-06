import { useEffect, useRef, type ReactNode } from "react";
import type { WikiPage } from "../../../shared/types";
import { WikiEditSplit } from "./WikiEditSplit";
import { PageSettingsPanel } from "./PageSettingsPanel";
import { useWikiEditor } from "./useWikiEditor";
import { formatRelative, formatSavedAt } from "./wiki-format";

// Lazy-loaded edit surface: importing this module pulls the whole TipTap
// editor graph, so WikiPageViewer only reaches for it once the reader opts
// into editing. Mounted only while editing; it calls handleStartEditing once
// the editor exists and asks the parent to unmount when editing ends.
function EditHeader({ breadcrumb, title, isSaving, historyPreviewId, settingsPanel, onCancel, onSave, onTitleChange }: {
  breadcrumb: string;
  title: string;
  isSaving: boolean;
  historyPreviewId: string | null;
  settingsPanel: ReactNode;
  onCancel: () => void;
  onSave: () => void;
  onTitleChange: (title: string) => void;
}) {
  return (
    <>
      <div
        className="flex items-center justify-between"
        style={{ padding: "12px 16px", borderBottom: "1px solid var(--lx-border-subtle)" }}
      >
        <div className="flex items-center gap-2">
          <span className="text-xs text-lx-text-muted font-body">{breadcrumb}</span>
          <span className="font-micro text-2xs text-lx-text-warning uppercase tracking-[0.04em]">Editing</span>
          {settingsPanel}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={onSave} disabled={isSaving || historyPreviewId !== null}>
            {isSaving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      <div style={{ padding: "12px 16px 0" }}>
        <input
          className="wiki-title-input"
          aria-label="Page title"
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          placeholder="Page title"
        />
      </div>
    </>
  );
}

interface WikiEditWorkspaceProps {
  slug: string;
  page: WikiPage;
  breadcrumb: string;
  onDone: () => void;
}

export function WikiEditWorkspace({ slug, page, breadcrumb, onDone }: WikiEditWorkspaceProps) {
  const {
    editor,
    isEditing,
    title,
    lastSavedPage,
    lastSavedAt,
    isDirty,
    isSaving,
    restoring,
    previewContent,
    historyPreviewId,
    autosaveEnabled,
    autosaveDelay,
    setAutosaveEnabled,
    setAutosaveDelay,
    handleStartEditing,
    handleCancel,
    handleSave,
    handleSelectRevision,
    handleClosePreview,
    handleRestore,
    handleReviewStateChange,
    handleTitleChange,
  } = useWikiEditor({ slug, page });

  const startedRef = useRef(false);
  const sawEditingRef = useRef(false);

  useEffect(() => {
    if (startedRef.current || !editor) return;
    startedRef.current = true;
    handleStartEditing();
  }, [editor]);

  // The hook leaves edit mode on save/cancel; hand control back to the reader.
  useEffect(() => {
    if (isEditing) {
      sawEditingRef.current = true;
      return;
    }
    if (sawEditingRef.current) onDone();
  }, [isEditing, onDone]);

  return (
    <div className="wiki-content wiki-edit-workspace">
      <div className="wiki-edit-main flex flex-col" style={{ padding: 0, overflow: "hidden" }}>
        <EditHeader
          breadcrumb={breadcrumb}
          title={title}
          isSaving={isSaving}
          historyPreviewId={historyPreviewId}
          onCancel={handleCancel}
          onSave={handleSave}
          onTitleChange={handleTitleChange}
          settingsPanel={
            <PageSettingsPanel
              slug={slug}
              pageSlug={page.slug}
              autosaveEnabled={autosaveEnabled}
              autosaveDelay={autosaveDelay}
              onAutosaveChange={setAutosaveEnabled}
              onDelayChange={setAutosaveDelay}
              selectedRevisionId={historyPreviewId}
              onSelectRevision={(id) => void handleSelectRevision(id)}
              onRestore={(id) => void handleRestore(id)}
              onClosePreview={handleClosePreview}
              restoring={restoring}
            />
          }
        />

        <WikiEditSplit
          editor={editor}
          slug={slug}
          pageSlug={page.slug}
          previewContent={previewContent}
          isSaving={isSaving}
          isDirty={isDirty}
          lastSavedAt={lastSavedAt}
          lastSavedLabel={isSaving ? "Saving…" : lastSavedAt ? formatSavedAt(lastSavedAt) : `Last edited ${formatRelative(lastSavedPage.updatedAt)}`}
          updatedByName={lastSavedPage.updatedByName}
          onReviewStateChange={handleReviewStateChange}
        />
      </div>
    </div>
  );
}
