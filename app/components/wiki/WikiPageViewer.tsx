import { lazy, Suspense, useMemo, useState } from "react";
import { Pencil, Share2 } from "lucide-react";
import type { WikiPage, WikiPageMeta, TipTapDoc } from "../../../shared/types";
import { renderDoc, extractHeadings, slugifyHeading } from "../tiptap-render";
import { OutlinePill } from "./OutlinePill";
import { SourcesSection } from "../document/SourcesSection";
import { formatRelative } from "./wiki-format";
import { ShareDialog } from "./ShareDialog";

// The editor (TipTap + mention suggestions + assistant review) is only needed
// after the reader clicks Edit — defer the whole module until then.
const WikiEditWorkspace = lazy(() =>
  import("./WikiEditWorkspace").then((m) => ({ default: m.WikiEditWorkspace }))
);

const emptyDoc: TipTapDoc = { type: "doc", content: [] };

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

function WikiReadView({ breadcrumb, title, content, updatedAt, updatedByName, headings, onEdit, onShare, slug, pageSlug }: {
  breadcrumb: string;
  title: string;
  content: TipTapDoc | undefined;
  updatedAt: string;
  updatedByName: string | null;
  headings: { level: number; text: string; id: string }[];
  onEdit: () => void;
  onShare: () => void;
  slug: string;
  pageSlug: string;
}) {
  const hasOutline = headings.some((heading) => heading.level >= 2);
  return (
    <>
      <div
        className={`wiki-content wiki-read-area${hasOutline ? " wiki-read-area--outline" : ""}`}
      >
        <div className="wiki-prose">
          <div className="text-xs text-lx-text-muted font-body" style={{ marginBottom: 4 }}>
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
              Last edited {formatRelative(updatedAt)}{updatedByName ? ` by ${updatedByName}` : ""}
            </span>
          </div>
        </div>
      </div>
      <OutlinePill headings={headings} />
    </>
  );
}

export function WikiPageViewer({ slug, page, pages }: WikiPageViewerProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  const breadcrumb = buildAncestors(pages, page)
    .map((a) => a.title)
    .join(" / ");

  // Stable identity so useScrollSpy's observer is not torn down and rebuilt on
  // every render of the viewer.
  const headings = useMemo(() => {
    const rawHeadings = extractHeadings(page.content as unknown as import("../tiptap-render").TTNode);
    return [
      { level: 1, text: page.title, id: slugifyHeading(page.title) },
      ...rawHeadings.filter((h) => h.level >= 2),
    ];
  }, [page.content, page.title]);

  if (!isEditing) {
    return (
      <>
        <WikiReadView
          breadcrumb={breadcrumb}
          title={page.title}
          content={page.content}
          updatedAt={page.updatedAt}
          updatedByName={page.updatedByName}
          headings={headings}
          onEdit={() => setIsEditing(true)}
          onShare={() => setShareOpen(true)}
          slug={slug}
          pageSlug={page.slug}
        />
        <ShareDialog slug={slug} pageSlug={page.slug} isOpen={shareOpen} onClose={() => setShareOpen(false)} />
      </>
    );
  }

  return (
    <Suspense fallback={null}>
      <WikiEditWorkspace
        slug={slug}
        page={page}
        breadcrumb={breadcrumb}
        onDone={() => setIsEditing(false)}
      />
    </Suspense>
  );
}
