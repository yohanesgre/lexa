import type { WikiPage, WikiPageMeta } from "../../../shared/types";
import { renderDoc } from "../tiptap-render";

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
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

export function WikiPageViewer({ page, pages }: { page: WikiPage; pages: WikiPageMeta[] }) {
  const ancestors = buildAncestors(pages, page);
  const breadcrumb = ancestors.map((a) => a.title).join(" / ");

  return (
    <>
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs text-lx-text-muted font-body">
          {breadcrumb ? `${breadcrumb} / ${page.title}` : page.title}
        </span>
      </div>
      <h1>{page.title}</h1>
      <div>{renderDoc(page.content, "wiki")}</div>
      <div className="mt-8 pt-4 border-t border-lx-border-default">
        <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">
          Last edited {formatRelative(page.updatedAt)}
        </span>
      </div>
    </>
  );
}
