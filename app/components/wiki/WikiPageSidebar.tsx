import { useEffect, useMemo, useState } from "react";
import { PanelLeft, Plus } from "lucide-react";
import { useSearchWikiPages } from "../../lib/queries";
import type { WikiPageMeta } from "../../../shared/types";
import { WikiSearchBox } from "./WikiSearchBox";
import { WikiSearchResults } from "./WikiSearchResults";
import { TreeItem } from "./WikiTreeItem";
import { buildTree, type WikiNode } from "./wiki-tree";

function padCount(n: number): string {
  return String(n).padStart(3, "0");
}

function buildPagesById(pages: WikiPageMeta[]): Map<string, WikiPageMeta> {
  return new Map(pages.map((p) => [p.id, p]));
}

type ListState = "loading" | "error" | "empty" | "ready";

function SidebarList({
  state,
  showResults,
  searching,
  results,
  tree,
  slug,
  pagesById,
  activePageSlug,
  expanded,
  onToggle,
  onContextMenu,
  contextMenuPageId,
  onNavigate,
}: {
  state: ListState;
  showResults: boolean;
  searching: boolean;
  results: (WikiPageMeta & { snippet: string })[];
  tree: WikiNode[];
  slug: string;
  pagesById: Map<string, WikiPageMeta>;
  activePageSlug?: string | undefined;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onContextMenu: (event: React.MouseEvent, page: WikiPageMeta) => void;
  contextMenuPageId: string | null;
  onNavigate?: (() => void) | undefined;
}) {
  return (
    <div className="flex-1 overflow-y-auto pt-2">
      {state === "loading" && <div className="px-4 text-xs text-lx-text-muted">Loading pages…</div>}
      {state === "error" && <div className="px-4 text-xs text-lx-text-danger">Failed to load pages</div>}

      {state === "empty" && (
        <div className="px-4 mb-3">
          <span className="font-micro text-2xs uppercase tracking-[0.04em] text-lx-text-muted">
            {padCount(0)} Pages
          </span>
        </div>
      )}

      {state === "ready" && showResults && (
        <WikiSearchResults results={results} searching={searching} slug={slug} pagesById={pagesById} onNavigate={onNavigate} />
      )}

      {state === "ready" && !showResults && tree.map((node) => (
        <TreeItem
          key={node.id}
          node={node}
          level={0}
          activeSlug={activePageSlug}
          slug={slug}
          expanded={expanded}
          onToggle={onToggle}
          onContextMenu={onContextMenu}
          contextMenuPageId={contextMenuPageId}
          onNavigate={onNavigate}
        />
      ))}
    </div>
  );
}

export function WikiPageSidebar({
  slug,
  activePageSlug,
  pages,
  isLoading,
  error,
  contextMenuPageId,
  onContextMenu,
  onNewPage,
  onClose,
  expanded,
  onToggleExpand,
  query,
  onQueryChange,
  searchFocused,
  onSearchFocusedChange,
  onNavigate,
}: {
  slug: string;
  activePageSlug?: string | undefined;
  pages: WikiPageMeta[] | undefined;
  isLoading: boolean;
  error: unknown;
  contextMenuPageId: string | null;
  onContextMenu: (event: React.MouseEvent, page: WikiPageMeta) => void;
  onNewPage: (defaultParentId: string | null) => void;
  onClose: () => void;
  expanded: Set<string>;
  onToggleExpand: (id: string) => void;
  query: string;
  onQueryChange: (q: string) => void;
  searchFocused: boolean;
  onSearchFocusedChange: (focused: boolean) => void;
  onNavigate?: (() => void) | undefined;
}) {
  const [debouncedQuery, setDebouncedQuery] = useState(query);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const tree = useMemo(() => (pages ? buildTree(pages) : []), [pages]);
  const pagesById = useMemo(() => (pages ? buildPagesById(pages) : new Map<string, WikiPageMeta>()), [pages]);

  const { data: results = [], isLoading: searching } = useSearchWikiPages(slug, debouncedQuery);
  const showResults = query.length > 0;

  const state: ListState = isLoading
    ? "loading"
    : error
      ? "error"
      : pages
        ? (pages.length === 0 ? "empty" : "ready")
        : "loading";

  return (
    <aside className="wiki-sidebar wiki-sidebar-open">
      <div className="sidebar-header">
        <div style={{ flex: 1, minWidth: 0 }}>
          <WikiSearchBox
            query={query}
            focused={searchFocused}
            onQueryChange={onQueryChange}
            onFocusedChange={onSearchFocusedChange}
          />
        </div>
        <button
          type="button"
          className="w-7 h-7 p-0 flex items-center justify-center text-lx-text-secondary hover:text-lx-text-primary flex-shrink-0 rounded"
          onClick={onClose}
          aria-label="Collapse sidebar"
        >
          <PanelLeft size={14} strokeWidth={1.5} />
        </button>
      </div>

      <SidebarList
        state={state}
        showResults={showResults}
        searching={searching}
        results={results}
        tree={tree}
        slug={slug}
        pagesById={pagesById}
        activePageSlug={activePageSlug}
        expanded={expanded}
        onToggle={onToggleExpand}
        onContextMenu={onContextMenu}
        contextMenuPageId={contextMenuPageId}
        onNavigate={onNavigate}
      />

      <div className="px-3 mt-2">
        <button
          type="button"
          className="add-task-btn"
          style={{ justifyContent: "flex-start", paddingLeft: "12px" }}
          onClick={() => onNewPage(null)}
        >
          <Plus size={14} strokeWidth={1.5} />
          New page
        </button>
      </div>
    </aside>
  );
}
