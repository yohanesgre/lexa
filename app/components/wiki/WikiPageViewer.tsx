import { useState } from "react";
import { Pencil, Share2 } from "lucide-react";
import type { WikiPage, WikiPageMeta, TipTapDoc } from "../../../shared/types";
import { renderDoc, extractHeadings, slugifyHeading } from "../tiptap-render";
import { WikiEditSplit } from "./WikiEditSplit";
import { EditSidebar } from "./EditSidebar";
import { OutlineSidebar } from "./OutlineSidebar";
import { SourcesSection } from "../forge/SourcesSection";
import { useWikiEditor } from "./useWikiEditor";
import { parseApiDate } from "../../lib/date";
import { ShareDialog } from "./ShareDialog";

const emptyDoc: TipTapDoc = { type: "doc", content: [] };

function formatRelative(iso: string): string {
  const then = parseApiDate(iso).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - then);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function formatSavedAt(date: Date): string {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `Saved ${h}:${m}`;
}

function buildAncestors(pages: WikiPageMeta[], page: WikiPage): WikiPageMeta[] {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const ancestors: WikiPageMeta[] = [];
  let currentId: string | null = page.parentId;
  while (currentId) {
    const parent = byId.get(currentId);
    if (!parent) break;
    ancestors.unshift(parent);
    currentId = parent.parentId;
  }
  return ancestors;
}

interface WikiPageViewerProps {
  slug: string;
  page: WikiPage;
  pages: WikiPageMeta[];
}

function WikiReadView({ breadcrumb, title, content, updatedAt, headings, outlineVisible, onToggleOutline, onEdit, onShare, slug, pageSlug }: {
  breadcrumb: string;
  title: string;
  content: TipTapDoc | undefined;
  updatedAt: string;
  headings: { level: number; text: string; id: string }[];
  outlineVisible: boolean;
  onToggleOutline: () => void;
  onEdit: () => void;
  onShare: () => void;
  slug: string;
  pageSlug: string;
}) {
  return (
    <>
      <div className="wiki-content">
        <div className="wiki-prose" style={{ maxWidth: 760, margin: "0 auto" }}>
          <div className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]" style={{ marginBottom: 4 }}>
            {breadcrumb}
          </div>
          <div className="flex items-center justify-between gap-4">
            <h1 id={slugifyHeading(title)} style={{ minWidth: 0 }}>{title}</h1>
            <span className="flex items-center gap-2 flex-shrink-0">
              <button type="button" className="btn btn-ghost" style={{ height: 28, padding: "0 10px", fontSize: 12 }} onClick={onEdit}>
                <Pencil size={13} strokeWidth={1.5} />
                Edit
              </button>
              <button type="button" className="btn btn-ghost-accent" style={{ height: 28, padding: "0 10px", fontSize: 12 }} onClick={onShare}>
                <Share2 size={13} strokeWidth={1.5} />
                Share
              </button>
            </span>
          </div>
          <div>{renderDoc(content ?? emptyDoc, "wiki", slug)}</div>
          <SourcesSection
            slug={slug}
            documentType="wiki"
            documentId={pageSlug}
            className="mt-8 pt-4 border-t border-lx-border-subtle"
          />
          <div className="mt-8 pt-4 border-t border-lx-border-subtle">
            <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">
              Last edited {formatRelative(updatedAt)}
            </span>
          </div>
        </div>
      </div>
      <OutlineSidebar headings={headings} collapsed={!outlineVisible} onToggle={onToggleOutline} />
    </>
  );
}

function EditHeader({ breadcrumb, title, isSaving, historyPreviewId, onCancel, onSave, onTitleChange }: {
  breadcrumb: string;
  title: string;
  isSaving: boolean;
  historyPreviewId: string | null;
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
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={onSave} disabled={isSaving || historyPreviewId !== null}>
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

export function WikiPageViewer({ slug, page, pages }: WikiPageViewerProps) {
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

  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [outlineVisible, setOutlineVisible] = useState(true);
  const [shareOpen, setShareOpen] = useState(false);

  const breadcrumb = buildAncestors(pages, page)
    .map((a) => a.title)
    .join(" / ");

  if (!isEditing) {
    const rawHeadings = extractHeadings(page.content as unknown as import("../tiptap-render").TTNode);
    const headings = [
      { level: 1, text: page.title, id: slugifyHeading(page.title) },
      ...rawHeadings.filter((h) => h.level >= 2),
    ];
    return (
      <>
        <WikiReadView
          breadcrumb={breadcrumb}
          title={page.title}
          content={page.content}
          updatedAt={page.updatedAt}
          headings={headings}
          outlineVisible={outlineVisible}
          onToggleOutline={() => setOutlineVisible(!outlineVisible)}
          onEdit={handleStartEditing}
          onShare={() => setShareOpen(true)}
          slug={slug}
          pageSlug={page.slug}
        />
        <ShareDialog slug={slug} pageSlug={page.slug} isOpen={shareOpen} onClose={() => setShareOpen(false)} />
      </>
    );
  }

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
          onReviewStateChange={handleReviewStateChange}
        />
      </div>

      <EditSidebar
        slug={slug}
        pageSlug={page.slug}
        autosaveEnabled={autosaveEnabled}
        autosaveDelay={autosaveDelay}
        onAutosaveChange={setAutosaveEnabled}
        onDelayChange={setAutosaveDelay}
        collapsed={!sidebarVisible}
        onToggle={() => setSidebarVisible(!sidebarVisible)}
        selectedRevisionId={historyPreviewId}
        onSelectRevision={(id) => void handleSelectRevision(id)}
        onRestore={(id) => void handleRestore(id)}
        onClosePreview={handleClosePreview}
        restoring={restoring}
      />
    </div>
  );
}
