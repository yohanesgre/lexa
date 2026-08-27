import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useScrollLock } from "../../lib/scroll-lock";
import { Search, ChevronRight, Plus, X, Pencil, FolderInput, Trash2, PanelLeft } from "lucide-react";
import { useWikiPages, useSearchWikiPages, useDeleteWikiPage } from "../../lib/queries";
import type { WikiPageMeta } from "../../../shared/types";
import { cn } from "../ui/cn";
import { NewPageModal } from "./NewPageModal";
import { WikiPageContextMenu } from "./WikiPageContextMenu";
import { WikiSearchBox } from "./WikiSearchBox";
import { RenamePageModal } from "./RenamePageModal";

interface WikiLayoutContext {
  openNewPage: () => void;
}

interface WikiLayoutProps {
  slug: string;
  activePageSlug?: string | undefined;
  children: (pages: WikiPageMeta[], ctx: WikiLayoutContext) => React.ReactNode;
}

type WikiNode = WikiPageMeta & { children: WikiNode[] };

function buildTree(pages: WikiPageMeta[]): WikiNode[] {
  const byParent = new Map<string | null, WikiPageMeta[]>();
  for (const page of pages) {
    const list = byParent.get(page.parentId) ?? [];
    list.push(page);
    byParent.set(page.parentId, list);
  }
  const sort = (list: WikiPageMeta[]) => [...list].toSorted((a, b) => a.position - b.position);
  const recurse = (parentId: string | null): WikiNode[] => {
    return sort(byParent.get(parentId) ?? []).map((p) => ({ ...p, children: recurse(p.id) }));
  };
  return recurse(null);
}

function buildPagesById(pages: WikiPageMeta[]): Map<string, WikiPageMeta> {
  return new Map(pages.map((p) => [p.id, p]));
}

function getBreadcrumb(pagesById: Map<string, WikiPageMeta>, page: WikiPageMeta): string[] {
  const path: string[] = [];
  let current: WikiPageMeta | null = page;
  while (current) {
    path.unshift(current.title);
    current = current.parentId ? pagesById.get(current.parentId) ?? null : null;
  }
  path.pop();
  return path;
}

function padCount(n: number): string {
  return String(n).padStart(3, "0");
}

const indentPadding: Record<number, number> = {
  0: 12,
  1: 28,
  2: 44,
  3: 60,
  4: 76,
  5: 92,
};

function getIndentPadding(level: number, isActive: boolean): number {
  const base = indentPadding[level] ?? indentPadding[5];
  // @ts-expect-error — strict: exactOptional indexedAccess
  return isActive ? base - 2 : base!;
}

function renderSnippet(snippet: string): React.ReactNode {
  const parts = snippet.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <mark key={part}>{part.slice(2, -2)}</mark>;
    }
    return <span key={part}>{part}</span>;
  });
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
  onContextMenu,
  contextMenuPageId,
}: {
  node: WikiNode;
  level: number;
  activeSlug?: string | undefined;
  slug: string;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onContextMenu: (event: React.MouseEvent, page: WikiPageMeta) => void;
  contextMenuPageId: string | null;
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
          isActive && "active border-l-2 border-l-lx-border-focus",
          contextMenuPageId === node.id && "bg-lx-surface-card-hover"
        )}
        style={{
          paddingLeft: getIndentPadding(level, isActive),
          marginLeft: isActive ? 8 : undefined,
        }}
        onContextMenu={(event) => onContextMenu(event, node)}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onToggle(node.id);
            }}
            className="chevron-small p-0.5 -ml-0.5"
            style={{ transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)" }}
            aria-label={isExpanded ? "Collapse" : "Expand"}
            onContextMenu={(event) => onContextMenu(event, node)}
          >
            <ChevronRight size={12} strokeWidth={2} />
          </button>
        ) : null}
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
            onContextMenu={onContextMenu}
            contextMenuPageId={contextMenuPageId}
          />
        ))}
    </>
  );
}

function SearchResult({
  slug,
  result,
  breadcrumb,
}: {
  slug: string;
  result: WikiPageMeta & { snippet: string };
  breadcrumb: string[];
}) {
  return (
    <Link
      to="/$slug/wiki/$pageSlug"
      params={{ slug, pageSlug: result.slug }}
      className="search-result"
    >
      {breadcrumb.length > 0 && (
        <div className="text-xs text-lx-text-muted font-body mb-1 truncate">
          {breadcrumb.join(" / ")}
        </div>
      )}
      <div className="text-sm font-medium text-lx-text-primary font-body">{result.title}</div>
      <div className="text-xs text-lx-text-secondary font-body mt-1 search-result-snippet">
        {renderSnippet(result.snippet)}
      </div>
    </Link>
  );
}

export function WikiLayout({ slug, activePageSlug, children }: WikiLayoutProps) {
  const navigate = useNavigate();
  const { data: pages, isLoading, error } = useWikiPages(slug);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [newPageModal, setNewPageModal] = useState<{ isOpen: boolean; defaultParentId: string | null }>({
    isOpen: false,
    defaultParentId: null,
  });
  const [renameModal, setRenameModal] = useState<{ isOpen: boolean; page: WikiPageMeta | null }>({
    isOpen: false,
    page: null,
  });
  const [contextMenu, setContextMenu] = useState<{
    pageId: string;
    pageTitle: string;
    pageSlug: string;
  } | null>(null);
  const [contextMenuPosition, setContextMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<WikiPageMeta | null>(null);

  const deletePage = useDeleteWikiPage(slug);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const [prevPages, setPrevPages] = useState(pages);
  if (pages !== prevPages) {
    setPrevPages(pages);
    if (pages) {
      setExpanded((prev) => (prev.size > 0 ? prev : new Set(pages.map((p) => p.id))));
    }
  }

  useEffect(() => {
    if (!contextMenu) return;
    function handleMouseDown(event: MouseEvent) {
      const target = event.target as Node;
      if (!target || !(target instanceof Node)) return;
      const menu = document.getElementById("wiki-page-context-menu");
      if (menu && !menu.contains(target)) {
        setContextMenu(null);
        setContextMenuPosition(null);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        setContextMenu(null);
        setContextMenuPosition(null);
      }
    }
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextMenu]);

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleContextMenu = useCallback((event: React.MouseEvent, page: WikiPageMeta) => {
    event.preventDefault();
    setContextMenu({ pageId: page.id, pageTitle: page.title, pageSlug: page.slug });
    setContextMenuPosition({ x: event.clientX, y: event.clientY });
  }, []);

  const handleAddChild = useCallback(() => {
    if (!contextMenu) return;
    setContextMenu(null);
    setContextMenuPosition(null);
    setNewPageModal({ isOpen: true, defaultParentId: contextMenu.pageId });
  }, [contextMenu]);

  const handleRename = useCallback(() => {
    if (!contextMenu || !pages) return;
    const page = pages.find((p) => p.id === contextMenu.pageId);
    if (!page) return;
    setContextMenu(null);
    setContextMenuPosition(null);
    setRenameModal({ isOpen: true, page });
  }, [contextMenu, pages]);

  const handleDelete = useCallback(() => {
    if (!deleteConfirm) return;
    deletePage.mutate(deleteConfirm.slug);
    if (deleteConfirm.slug === activePageSlug) {
      navigate({ to: "/$slug/wiki", params: { slug } });
    }
    setDeleteConfirm(null);
  }, [deleteConfirm, activePageSlug, slug, deletePage, navigate]);

  const tree = pages ? buildTree(pages) : [];
  const pagesById = useMemo(() => (pages ? buildPagesById(pages) : new Map<string, WikiPageMeta>()), [pages]);

  const { data: results = [], isLoading: searching } = useSearchWikiPages(slug, debouncedQuery);

  const showResults = query.length > 0;
  // Narrow screens start collapsed so the tree never starves the content.
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(max-width: 767px)").matches
      : false
  );

  // The top nav's "PanelLeft" button dispatches this event on mobile. We
  // open the sidebar so the user can pick a different page. Desktop
  // behavior is unchanged (the rail remains the entry point there).
  useEffect(() => {
    function handleToggle() {
      if (typeof window.matchMedia === "function" && window.matchMedia("(max-width: 767px)").matches) {
        setSidebarCollapsed(false);
      }
    }
    window.addEventListener("lexa:toggle-wiki-sidebar", handleToggle);
    return () => window.removeEventListener("lexa:toggle-wiki-sidebar", handleToggle);
  }, []);

  // Lock body scroll while the wiki sidebar is open.
  useEffect(() => {
    return useScrollLock(!sidebarCollapsed);
  }, [sidebarCollapsed]);

  return (
    <div className="wiki-layout">
      {sidebarCollapsed ? (
        <aside
          className="wiki-sidebar wiki-sidebar-rail"
        >
          <button
            type="button"
            className="w-7 h-7 p-0 flex items-center justify-center text-lx-text-secondary hover:text-lx-text-primary rounded"
            onClick={() => setSidebarCollapsed(false)}
            aria-label="Expand sidebar"
            title="Pages"
          >
            <PanelLeft size={14} strokeWidth={1.5} />
          </button>
        </aside>
      ) : (
      <aside className="wiki-sidebar wiki-sidebar-open">
        <div className="sidebar-header">
          <div style={{ flex: 1, minWidth: 0 }}>
            <WikiSearchBox
              query={query}
              focused={isSearchFocused}
              onQueryChange={setQuery}
              onFocusedChange={setIsSearchFocused}
            />
          </div>
          <button
            type="button"
            className="w-7 h-7 p-0 flex items-center justify-center text-lx-text-secondary hover:text-lx-text-primary flex-shrink-0 rounded"
            onClick={() => setSidebarCollapsed(true)}
            aria-label="Collapse sidebar"
          >
            <PanelLeft size={14} strokeWidth={1.5} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto pt-2">
          {isLoading && <div className="px-4 text-xs text-lx-text-muted">Loading pages…</div>}
          {error && <div className="px-4 text-xs text-lx-text-danger">Failed to load pages</div>}

          {!isLoading && !error && pages && pages.length === 0 && (
            <div className="px-4 mb-3">
              <span className="font-micro text-2xs uppercase tracking-[0.04em] text-lx-text-muted">
                {padCount(pages.length)} Pages
              </span>
            </div>
          )}

          {!isLoading && !error && pages && pages.length > 0 && showResults && (
            <>
              <div className="px-4 mb-2 flex items-center justify-between">
                <span className="font-micro text-2xs uppercase tracking-[0.04em] text-lx-text-muted">
                  {padCount(results.length)} Results
                </span>
              </div>
              {searching && (
                <div className="px-4 text-xs text-lx-text-muted py-2">Searching…</div>
              )}
              {!searching && results.length === 0 && (
                <div className="px-4 text-xs text-lx-text-muted py-2">No results found.</div>
              )}
              {results.map((result) => (
                <SearchResult
                  key={result.id}
                  slug={slug}
                  result={result}
                  breadcrumb={getBreadcrumb(pagesById, result)}
                />
              ))}
            </>
          )}

          {!isLoading && !error && pages && pages.length > 0 && !showResults && tree.map((node) => (
            <TreeItem
              key={node.id}
              node={node}
              level={0}
              activeSlug={activePageSlug}
              slug={slug}
              expanded={expanded}
              onToggle={toggle}
              onContextMenu={handleContextMenu}
              contextMenuPageId={contextMenu?.pageId ?? null}
            />
          ))}

          {contextMenu && contextMenuPosition && (
            <WikiPageContextMenu
              x={contextMenuPosition.x}
              y={contextMenuPosition.y}
              onAddChild={handleAddChild}
              onRename={handleRename}
              onDelete={() => {
                if (!contextMenu || !pages) return;
                const page = pages.find((p) => p.id === contextMenu.pageId);
                if (page) setDeleteConfirm(page);
                setContextMenu(null);
                setContextMenuPosition(null);
              }}
            />
          )}
        </div>

        <div className="px-3 mt-2">
          <button
            type="button"
            className="add-task-btn"
            style={{ justifyContent: "flex-start", paddingLeft: "12px" }}
            onClick={() => setNewPageModal({ isOpen: true, defaultParentId: null })}
          >
            <Plus size={14} strokeWidth={1.5} />
            New page
          </button>
        </div>
      </aside>
      )}

      {newPageModal.isOpen && (
<NewPageModal
        slug={slug}
        isOpen={newPageModal.isOpen}
        onClose={() => setNewPageModal({ isOpen: false, defaultParentId: null })}
        defaultParentId={newPageModal.defaultParentId}
        pages={pages ?? []}
      />
      )}

      {renameModal.isOpen && (
<RenamePageModal
        slug={slug}
        page={renameModal.page}
        isOpen={renameModal.isOpen}
        onClose={() => setRenameModal({ isOpen: false, page: null })}
      />
      )}

      {deleteConfirm && (
        <>
          <button type="button" className="dialog-overlay" onClick={() => setDeleteConfirm(null)} aria-label="Close" />
          <div className="fixed inset-0 flex items-center justify-center z-[80] pointer-events-none">
            <dialog open
              className="dialog dialog-enter pointer-events-auto p-4"
              style={{ width: 360, maxWidth: "calc(100vw - 48px)" }}
              aria-modal="true"
              aria-labelledby="delete-page-title"
            >
              <h3 id="delete-page-title" className="font-display text-lg font-medium text-lx-text-primary">
                Delete page
              </h3>
              <p className="text-sm text-lx-text-secondary mt-3 leading-5">
                Delete <span className="text-lx-text-primary font-medium">&lsquo;{deleteConfirm.title}&rsquo;</span>? This cannot be undone.
              </p>
              <div className="flex items-center gap-2 mt-4 justify-end">
                <button type="button" className="btn btn-ghost" onClick={() => setDeleteConfirm(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-danger-solid"
                  onClick={handleDelete}
                  disabled={deletePage.isPending}
                >
                  Delete
                </button>
              </div>
            </dialog>
          </div>
        </>
      )}

      {pages
        ? children(pages, { openNewPage: () => setNewPageModal({ isOpen: true, defaultParentId: null }) })
        : null}
    </div>
  );
}