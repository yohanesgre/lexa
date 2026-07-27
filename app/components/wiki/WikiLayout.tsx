import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Search, ChevronRight, Plus } from "lucide-react";
import { useWikiPages } from "../../lib/queries";
import type { WikiPageMeta } from "../../../shared/types";
import { cn } from "../ui/cn";

interface WikiLayoutProps {
  slug: string;
  activePageSlug?: string;
  children: (pages: WikiPageMeta[]) => React.ReactNode;
}

type WikiNode = WikiPageMeta & { children: WikiNode[] };

function buildTree(pages: WikiPageMeta[]): WikiNode[] {
  const byParent = new Map<string | null, WikiPageMeta[]>();
  for (const page of pages) {
    const list = byParent.get(page.parentId) ?? [];
    list.push(page);
    byParent.set(page.parentId, list);
  }
  const sort = (list: WikiPageMeta[]) => [...list].sort((a, b) => a.position - b.position);
  const recurse = (parentId: string | null): WikiNode[] => {
    return sort(byParent.get(parentId) ?? []).map((p) => ({ ...p, children: recurse(p.id) }));
  };
  return recurse(null);
}

function PageIcon({ className }: { className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className={className}
    >
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function TreeItem({
  node,
  level,
  activeSlug,
  slug,
  expanded,
  onToggle,
}: {
  node: WikiNode;
  level: number;
  activeSlug?: string;
  slug: string;
  expanded: Set<string>;
  onToggle: (id: string) => void;
}) {
  const isActive = node.slug === activeSlug;
  const isExpanded = expanded.has(node.id);
  const hasChildren = node.children.length > 0;

  return (
    <>
      <Link
        to="/$slug/wiki/$pageSlug"
        params={{ slug, pageSlug: node.slug }}
        className={cn(
          "tree-item",
          level === 1 && "tree-indent-1",
          level === 2 && "tree-indent-2",
          level >= 3 && "tree-indent-3",
          isActive && "active border-l-[3px] border-l-lx-accent"
        )}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onToggle(node.id);
            }}
            className="chevron-small p-1 -ml-1"
            style={{ transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)" }}
            aria-label={isExpanded ? "Collapse" : "Expand"}
          >
            <ChevronRight size={12} strokeWidth={2} />
          </button>
        ) : (
          <span className="w-3 h-3 mr-1 shrink-0" />
        )}
        <PageIcon className="text-lx-text-muted mr-1.5 shrink-0" />
        <span className="truncate">{node.title}</span>
      </Link>
      {isExpanded &&
        node.children.map((child) => (
          <TreeItem
            key={child.id}
            node={child}
            level={level + 1}
            activeSlug={activeSlug}
            slug={slug}
            expanded={expanded}
            onToggle={onToggle}
          />
        ))}
    </>
  );
}

export function WikiLayout({ slug, activePageSlug, children }: WikiLayoutProps) {
  const { data: pages, isLoading, error } = useWikiPages(slug);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!pages) return;
    setExpanded((prev) => {
      if (prev.size > 0) return prev;
      return new Set(pages.map((p) => p.id));
    });
  }, [pages]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const tree = pages ? buildTree(pages) : [];

  return (
    <div className="wiki-layout">
      <aside className="wiki-sidebar">
        <div className="px-4 mb-3">
          <div className="flex items-center gap-2 px-3 h-8 rounded-md border border-lx-border bg-lx-surface-input text-lx-text-muted">
            <Search size={14} strokeWidth={1.5} />
            <span className="text-xs font-body">Search wiki...</span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {isLoading && <div className="px-4 text-xs text-lx-text-muted">Loading pages…</div>}
          {error && <div className="px-4 text-xs text-lx-text-danger">Failed to load pages</div>}
          {tree.map((node) => (
            <TreeItem
              key={node.id}
              node={node}
              level={0}
              activeSlug={activePageSlug}
              slug={slug}
              expanded={expanded}
              onToggle={toggle}
            />
          ))}
        </div>

        <div className="px-3 mt-2">
          <button
            type="button"
            className="add-task-btn"
            style={{ justifyContent: "flex-start", paddingLeft: "12px" }}
            onClick={() => {
              /* TODO: Phase 4.3 new page flow */
            }}
          >
            <Plus size={14} strokeWidth={1.5} />
            New page
          </button>
        </div>
      </aside>

      <div className="wiki-content">
        <div className="wiki-prose">{pages ? children(pages) : null}</div>
      </div>
    </div>
  );
}
