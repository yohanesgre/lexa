import { useEffect, useMemo, useRef, useState } from "react";
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

function findNodeIdBySlug(nodes: WikiNode[], slug?: string): string | null {
  if (!slug) return null;
  for (const node of nodes) {
    if (node.slug === slug) return node.id;
    const child = findNodeIdBySlug(node.children, slug);
    if (child) return child;
  }
  return null;
}

function findNodeById(nodes: WikiNode[], id: string | null): WikiNode | null {
  if (!id) return null;
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = findNodeById(node.children, id);
    if (child) return child;
  }
  return null;
}

type ListState = "loading" | "error" | "empty" | "ready";

function SidebarList({
  state,
  showResults,
  searching,
  searchError,
  query,
  onRetrySearch,
  results,
  tree,
  slug,
  pagesById,
  activePageSlug,
  expanded,
  onToggle,
  onContextMenu,
  onContextMenuKeyboard,
  contextMenuPageId,
  onNavigate,
  onRetryList,
}: {
  state: ListState;
  showResults: boolean;
  searching: boolean;
  searchError: boolean;
  query: string;
  onRetrySearch: () => void;
  results: (WikiPageMeta & { snippet: string })[];
  tree: WikiNode[];
  slug: string;
  pagesById: Map<string, WikiPageMeta>;
  activePageSlug?: string | undefined;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onContextMenu: (event: React.MouseEvent, page: WikiPageMeta) => void;
  onContextMenuKeyboard: (element: HTMLElement, page: WikiPageMeta) => void;
  contextMenuPageId: string | null;
  onNavigate?: (() => void) | undefined;
  onRetryList: () => void;
}) {
  const treeRef = useRef<HTMLDivElement | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const activeNodeId = findNodeIdBySlug(tree, activePageSlug);
  // A focused row can vanish (page deleted) — fall back to the active/first row
  // so the tree always keeps exactly one tabbable treeitem.
  const tabbableId = findNodeById(tree, focusedId) ? focusedId : activeNodeId ?? tree[0]?.id ?? null;

  const treeItems = () =>
    Array.from(treeRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? []);

  const focusItem = (element: HTMLElement | undefined) => {
    if (!element) return;
    element.focus();
    const id = element.dataset.nodeId;
    if (id) setFocusedId(id);
  };

  const handleTreeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
    if (!target) return;
    const items = treeItems();
    const index = items.indexOf(target);
    if (index === -1) return;
    const level = Number(target.getAttribute("aria-level") ?? 1);
    // Windows/Context-Menu key and Shift+F10 open the row's action menu.
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      event.preventDefault();
      const page = findNodeById(tree, target.dataset.nodeId ?? null);
      if (page) onContextMenuKeyboard(target, page);
      return;
    }
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusItem(items[index + 1]);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusItem(items[index - 1]);
        break;
      case "Home":
        event.preventDefault();
        focusItem(items[0]);
        break;
      case "End":
        event.preventDefault();
        focusItem(items[items.length - 1]);
        break;
      case "ArrowRight": {
        if (target.getAttribute("aria-expanded") === "false") {
          event.preventDefault();
          const id = target.dataset.nodeId;
          if (id) onToggle(id);
          break;
        }
        const next = items[index + 1];
        if (next && Number(next.getAttribute("aria-level")) > level) {
          event.preventDefault();
          focusItem(next);
        }
        break;
      }
      case "ArrowLeft": {
        if (target.getAttribute("aria-expanded") === "true") {
          event.preventDefault();
          const id = target.dataset.nodeId;
          if (id) onToggle(id);
          break;
        }
        event.preventDefault();
        for (let i = index - 1; i >= 0; i -= 1) {
          if (Number(items[i]!.getAttribute("aria-level")) < level) {
            focusItem(items[i]);
            break;
          }
        }
        break;
      }
      case "Enter":
      case " ":
        event.preventDefault();
        target.querySelector<HTMLElement>("a")?.click();
        break;
      default:
        break;
    }
  };

  return (
    <div className="flex-1 overflow-y-auto pt-2">
      {state === "loading" && <div className="px-4 text-xs text-lx-text-muted">Loading pages…</div>}
      {state === "error" && (
        <div className="px-3">
          <div className="tasks-error">
            <div className="tasks-error-title">Failed to load pages</div>
            <div className="tasks-error-sub">
              <span className="font-mono">Network error</span> — the pages query failed to load
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onRetryList}>
              Retry
            </button>
          </div>
        </div>
      )}

      {state === "empty" && (
        <div className="px-4 mb-3">
          <span className="font-micro text-2xs uppercase tracking-[0.04em] text-lx-text-muted">
            {padCount(0)} Pages
          </span>
        </div>
      )}

      {state === "ready" && showResults && (
        <WikiSearchResults
          query={query}
          results={results}
          searching={searching}
          error={searchError}
          slug={slug}
          pagesById={pagesById}
          onNavigate={onNavigate}
          onRetry={onRetrySearch}
        />
      )}

      {state === "ready" && !showResults && (
        <div role="tree" aria-label="Wiki pages" ref={treeRef} onKeyDown={handleTreeKeyDown}>
          {tree.map((node) => (
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
              tabbableId={tabbableId}
              onFocus={setFocusedId}
            />
          ))}
        </div>
      )}
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
  onContextMenuKeyboard,
  onNewPage,
  onClose,
  expanded,
  onToggleExpand,
  query,
  onQueryChange,
  searchFocused,
  onSearchFocusedChange,
  onNavigate,
  onRetryPages,
  panelRef,
}: {
  slug: string;
  activePageSlug?: string | undefined;
  pages: WikiPageMeta[] | undefined;
  isLoading: boolean;
  error: unknown;
  onRetryPages: () => void;
  contextMenuPageId: string | null;
  onContextMenu: (event: React.MouseEvent, page: WikiPageMeta) => void;
  onContextMenuKeyboard: (element: HTMLElement, page: WikiPageMeta) => void;
  onNewPage: (defaultParentId: string | null) => void;
  onClose: () => void;
  expanded: Set<string>;
  onToggleExpand: (id: string) => void;
  query: string;
  onQueryChange: (q: string) => void;
  searchFocused: boolean;
  onSearchFocusedChange: (focused: boolean) => void;
  onNavigate?: (() => void) | undefined;
  panelRef?: React.RefObject<HTMLElement | null> | undefined;
}) {
  const [debouncedQuery, setDebouncedQuery] = useState(query);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const tree = useMemo(() => (pages ? buildTree(pages) : []), [pages]);
  const pagesById = useMemo(() => (pages ? buildPagesById(pages) : new Map<string, WikiPageMeta>()), [pages]);

  const search = useSearchWikiPages(slug, debouncedQuery);
  const results = search.data ?? [];
  const searching = (query.length > 0 && debouncedQuery !== query) || search.isLoading;
  const showResults = query.length > 0;
  const retrySearch = () => {
    void search.refetch();
  };

  const state: ListState = isLoading
    ? "loading"
    : error
      ? "error"
      : pages
        ? (pages.length === 0 ? "empty" : "ready")
        : "loading";

  return (
    <aside ref={panelRef} id="wiki-sidebar" className="wiki-sidebar wiki-sidebar-open">
      <div className="sidebar-header">
        {state === "empty" ? (
          <div style={{ flex: 1 }} />
        ) : (
          <div style={{ flex: 1, minWidth: 0 }}>
            <WikiSearchBox
              query={query}
              focused={searchFocused}
              onQueryChange={onQueryChange}
              onFocusedChange={onSearchFocusedChange}
            />
          </div>
        )}
        <button
          type="button"
          className="sidebar-toggle w-8 h-8 p-0 flex items-center justify-center text-lx-text-secondary hover:text-lx-text-primary flex-shrink-0 rounded"
          onClick={onClose}
          aria-label="Collapse sidebar"
          aria-expanded={true}
          aria-controls="wiki-sidebar"
          title="Collapse sidebar"
        >
          <PanelLeft size={14} strokeWidth={1.5} />
        </button>
      </div>

      <SidebarList
        state={state}
        showResults={showResults}
        searching={searching}
        searchError={!!search.error}
        query={query}
        onRetrySearch={retrySearch}
        results={results}
        tree={tree}
        slug={slug}
        pagesById={pagesById}
        activePageSlug={activePageSlug}
        expanded={expanded}
        onToggle={onToggleExpand}
        onContextMenu={onContextMenu}
        onContextMenuKeyboard={onContextMenuKeyboard}
        contextMenuPageId={contextMenuPageId}
        onNavigate={onNavigate}
        onRetryList={onRetryPages}
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
