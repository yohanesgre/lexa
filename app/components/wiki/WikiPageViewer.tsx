import { useMemo, useState } from "react";
import { Pencil, Share2 } from "lucide-react";
import type { WikiPage, WikiPageMeta, TipTapDoc } from "../../../shared/types";
import { renderDoc, planHeadings, slugifyHeading, type HeadingOutline, type TTNode } from "../tiptap-render";
import { OutlinePill } from "./OutlinePill";
import { OutlineRail } from "./OutlineRail";
import { useScrollSpy } from "../../lib/use-scroll-spy";
import { SourcesSection } from "../document/SourcesSection";
import { formatRelative } from "./wiki-format";
import { ShareDialog } from "./ShareDialog";
import { WikiEditWorkspace } from "./WikiEditWorkspace";

const emptyDoc: TipTapDoc = { type: "doc", content: [] };

// Stable identity: a page with no navigator must not re-render its document on
// every scroll frame.
const NO_SECTIONS: HeadingOutline[] = [];

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

function WikiReadView({ breadcrumb, title, titleId, content, updatedAt, updatedByName, headings, headingIds, onEdit, onShare, slug, pageSlug }: {
  breadcrumb: string;
  title: string;
  titleId: string;
  content: TipTapDoc | undefined;
  updatedAt: string;
  updatedByName: string | null;
  headings: HeadingOutline[];
  headingIds: Map<TTNode, string>;
  onEdit: () => void;
  onShare: () => void;
  slug: string;
  pageSlug: string;
}) {
  // A short page has nothing to navigate: three sections earn the navigator.
  const hasNav = headings.length >= 3;
  const { activeId, scrollTo } = useScrollSpy(hasNav ? headings : NO_SECTIONS);
  return (
    <main className="wiki-content wiki-read-area">
      <div className="wiki-read-shell">
        <div className={`wiki-doc-layout${hasNav ? " wiki-doc-layout--rail" : ""}`}>
          <article className="wiki-doc-column">
            <div className="wiki-prose">
              <div className="text-xs text-lx-text-muted font-body" style={{ marginBottom: 4 }}>
                {breadcrumb}
              </div>
              {/* The actions ride the title's row while the column has room for
                  both; a long title takes its own line and the pair drops
                  below it, still flush to the column's right edge (flex
                  line-breaking makes that decision off the real title width,
                  so no breakpoint or threshold carries it). */}
              <div className="flex flex-wrap items-center justify-between gap-4">
                <h1 id={titleId} style={{ minWidth: 0 }}>{title}</h1>
                <span className="flex items-center gap-2 flex-shrink-0 ml-auto">
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
              <div>{renderDoc(content ?? emptyDoc, "wiki", slug, undefined, headingIds)}</div>
              <SourcesSection
                slug={slug}
                documentType="wiki"
                documentId={pageSlug}
                className="mt-8 pt-4 border-t border-lx-border-subtle"
              />
              <div className="mt-8 pt-4 border-t border-lx-border-subtle">
                <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">
                  Last edited {formatRelative(updatedAt)}{updatedByName ? ` by ${updatedByName}` : ""}
                </span>
              </div>
            </div>
          </article>
          {hasNav && <OutlineRail headings={headings} activeId={activeId} onSelect={scrollTo} />}
        </div>
        {hasNav && <OutlinePill headings={headings} activeId={activeId} onSelect={scrollTo} />}
      </div>
    </main>
  );
}

export function WikiPageViewer({ slug, page, pages }: WikiPageViewerProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  const breadcrumb = buildAncestors(pages, page)
    .map((a) => a.title)
    .join(" / ");

  // Stable identities so useScrollSpy's listener is not torn down and rebuilt
  // on every render of the viewer. The title is rendered as the page's own h1,
  // so its slug is reserved here: a heading repeating it takes the -2 suffix.
  const titleId = slugifyHeading(page.title);
  const plan = useMemo(
    () => planHeadings(page.content as unknown as TTNode, [titleId]),
    [page.content, titleId]
  );
  const sections = useMemo(
    () => plan.headings.filter((heading) => heading.level >= 2),
    [plan]
  );

  const readView = (
    <WikiReadView
      breadcrumb={breadcrumb}
      title={page.title}
      titleId={titleId}
      content={page.content}
      updatedAt={page.updatedAt}
      updatedByName={page.updatedByName}
      headings={sections}
      headingIds={plan.ids}
      onEdit={() => setIsEditing(true)}
      onShare={() => setShareOpen(true)}
      slug={slug}
      pageSlug={page.slug}
    />
  );

  if (!isEditing) {
    return (
      <>
        {readView}
        <ShareDialog slug={slug} pageSlug={page.slug} isOpen={shareOpen} onClose={() => setShareOpen(false)} />
      </>
    );
  }

  return (
    <WikiEditWorkspace
      slug={slug}
      page={page}
      breadcrumb={breadcrumb}
      onDone={() => setIsEditing(false)}
    />
  );
}
