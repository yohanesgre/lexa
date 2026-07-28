import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState, useCallback } from "react";
import { Search, ChevronRight, Plus, X, Pencil, FolderInput, Trash2 } from "lucide-react";
import { useWikiPages, useSearchWikiPages, useDeleteWikiPage } from "../../lib/queries";
import type { WikiPageMeta } from "../../../shared/types";
import { cn } from "../ui/cn";
import { NewPageModal } from "./NewPageModal";
import { RenamePageModal } from "./RenamePageModal";

interface WikiLayoutContext {
  openNewPage: () => void;
}

interface WikiLayoutProps {
  slug: string;
  activePageSlug?: string;
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
  const sort = (list: WikiPageMeta[]) => [...list].sort((a, b) => a.position - b.position);
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

function renderSnippet(snippet: string): React.ReactNode {
  const parts = snippet.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <mark key={index}>{part.slice(2, -2)}</mark>;
    }
    return <span key={index}>{part}</span>;
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
  activeSlug?: string;
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
          level === 1 && "tree-indent-1",
          level === 2 && "tree-indent-2",
          level >= 3 && "tree-indent-3",
          isActive && "active border-l-[3px] border-l-lx-accent",
          contextMenuPageId === node.id && "bg-lx-surface-card-hover"
        )}
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
            className="chevron-small p-1 -ml-1"
            style={{ transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)" }}
            aria-label={isExpanded ? "Collapse" : "Expand"}
            onContextMenu={(event) => onContextMenu(event, node)}
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

  useEffect(() => {
    if (!pages) return;
    setExpanded((prev) => {
      if (prev.size > 0) return prev;
      return new Set(pages.map((p) => p.id));
    });
  }, [pages]);

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

  return (
    <div className="wiki-layout">
      <aside className="wiki-sidebar">
        <div className="px-4 mb-3">
          <div className="relative">
            <Search
              size={14}
              strokeWidth={1.5}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-lx-text-muted pointer-events-none"
            />
            <input
              type="text"
              className="prop-input w-full pl-8 pr-8"
              placeholder="Search wiki..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query.length > 0 && (
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 inline-flex items-center justify-center rounded text-lx-text-muted hover:text-lx-text-primary"
                onClick={() => setQuery("")}
                aria-label="Clear search"
              >
                <X size={12} strokeWidth={1.5} />
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
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
            <div
              id="wiki-page-context-menu"
              className="menu"
              style={{ left: contextMenuPosition.x, top: contextMenuPosition.y }}
              role="menu"
            >
              <button
                type="button"
                className="menu-item"
                onClick={handleAddChild}
                role="menuitem"
              >
                <Plus size={14} strokeWidth={1.5} />
                Add child page
              </button>
              <button
                type="button"
                className="menu-item"
                onClick={handleRename}
                role="menuitem"
              >
                <Pencil size={14} strokeWidth={1.5} />
                Rename
              </button>
              <button
                type="button"
                className="menu-item"
                disabled
                role="menuitem"
                aria-disabled="true"
              >
                <FolderInput size={14} strokeWidth={1.5} />
                Move
              </button>
              <div className="menu-separator" />
              <button
                type="button"
                className="menu-item danger"
                onClick={() => {
                  if (!contextMenu || !pages) return;
                  const page = pages.find((p) => p.id === contextMenu.pageId);
                  if (page) setDeleteConfirm(page);
                  setContextMenu(null);
                  setContextMenuPosition(null);
                }}
                role="menuitem"
              >
                <Trash2 size={14} strokeWidth={1.5} />
                Delete
              </button>
            </div>
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

      <NewPageModal
        slug={slug}
        isOpen={newPageModal.isOpen}
        onClose={() => setNewPageModal({ isOpen: false, defaultParentId: null })}
        defaultParentId={newPageModal.defaultParentId}
        pages={pages ?? []}
      />

      <RenamePageModal
        slug={slug}
        page={renameModal.page}
        isOpen={renameModal.isOpen}
        onClose={() => setRenameModal({ isOpen: false, page: null })}
      />

      {deleteConfirm && (
        <>
          <div className="dialog-overlay" onClick={() => setDeleteConfirm(null)} />
          <div className="fixed inset-0 flex items-center justify-center z-[80] pointer-events-none">
            <div
              className="dialog dialog-enter pointer-events-auto p-4"
              style={{ width: 360, maxWidth: "calc(100vw - 48px)" }}
              role="alertdialog"
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
            </div>
          </div>
        </>
      )}

      <div className="wiki-content">
        <div className="wiki-prose">
          {pages
            ? children(pages, { openNewPage: () => setNewPageModal({ isOpen: true, defaultParentId: null }) })
            : null}
        </div>
      </div>
    </div>
  );
}
