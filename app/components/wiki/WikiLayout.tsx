import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, useCallback } from "react";
import { PanelLeft } from "lucide-react";
import { lockScroll } from "../../lib/scroll-lock";
import { useOverlayFocusTrap, useSidebarState } from "../../lib/sidebar-state";
import { useWikiPages, useDeleteWikiPage } from "../../lib/queries";
import type { WikiPageMeta } from "../../../shared/types";
import { NewPageModal } from "./NewPageModal";
import { WikiPageContextMenu, MovePageModal } from "./WikiPageContextMenu";
import { RenamePageModal } from "./RenamePageModal";
import { WikiPageSidebar } from "./WikiPageSidebar";
import { WikiDeletePageDialog } from "./WikiDeletePageDialog";

interface WikiLayoutContext {
  openNewPage: () => void;
}

interface WikiLayoutProps {
  slug: string;
  activePageSlug?: string | undefined;
  children: (pages: WikiPageMeta[], ctx: WikiLayoutContext) => React.ReactNode;
}

interface WikiContextMenuState {
  pageId: string;
  pageTitle: string;
  pageSlug: string;
  anchor: { top: number; left: number };
}

// Right-click menu lifecycle: open on contextmenu, dismiss on outside
// mousedown or Escape. The menu anchors below the row it was opened from
// (D3, never at the cursor); Escape returns focus to that row.
function useWikiPageContextMenu(
  pages: WikiPageMeta[] | undefined,
  actions: {
    onAddChild: (pageId: string) => void;
    onRename: (page: WikiPageMeta) => void;
    onMove: (page: WikiPageMeta) => void;
    onDelete: (page: WikiPageMeta) => void;
  }
) {
  const [menu, setMenu] = useState<WikiContextMenuState | null>(null);
  const rowRef = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    setMenu(null);
    const row = rowRef.current;
    rowRef.current = null;
    if (row && row.isConnected) row.focus();
  }, []);

  useEffect(() => {
    if (!menu) return;
    function handleMouseDown(event: MouseEvent) {
      const target = event.target as Node;
      if (!target || !(target instanceof Node)) return;
      const menuEl = document.getElementById("wiki-page-context-menu");
      if (menuEl && !menuEl.contains(target)) {
        rowRef.current = null;
        setMenu(null);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    }
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menu, close]);

  const open = useCallback((event: React.MouseEvent, page: WikiPageMeta) => {
    event.preventDefault();
    const row = event.currentTarget as HTMLElement;
    const rect = row.getBoundingClientRect();
    rowRef.current = row;
    setMenu({
      pageId: page.id,
      pageTitle: page.title,
      pageSlug: page.slug,
      anchor: { top: rect.bottom, left: rect.left },
    });
  }, []);

  const addChild = useCallback(() => {
    if (!menu) return;
    setMenu(null);
    actions.onAddChild(menu.pageId);
  }, [menu, actions]);

  const rename = useCallback(() => {
    if (!menu || !pages) return;
    const page = pages.find((p) => p.id === menu.pageId);
    if (!page) return;
    setMenu(null);
    actions.onRename(page);
  }, [menu, pages, actions]);

  const move = useCallback(() => {
    if (!menu || !pages) return;
    const page = pages.find((p) => p.id === menu.pageId);
    if (!page) return;
    setMenu(null);
    actions.onMove(page);
  }, [menu, pages, actions]);

  const remove = useCallback(() => {
    if (!menu || !pages) return;
    const page = pages.find((p) => p.id === menu.pageId);
    if (page) actions.onDelete(page);
    setMenu(null);
  }, [menu, pages, actions]);

  return { menu, open, close, addChild, rename, move, remove };
}

function SidebarRail({ onExpand }: { onExpand: () => void }) {
  return (
    <aside id="wiki-sidebar" className="wiki-sidebar wiki-sidebar-rail">
      <button
        type="button"
        className="sidebar-toggle w-8 h-8 p-0 flex items-center justify-center text-lx-text-secondary hover:text-lx-text-primary rounded"
        onClick={onExpand}
        aria-label="Expand sidebar"
        aria-expanded={false}
        aria-controls="wiki-sidebar"
        title="Expand sidebar"
      >
        <PanelLeft size={14} strokeWidth={1.5} />
      </button>
    </aside>
  );
}

export function WikiLayout({ slug, activePageSlug, children }: WikiLayoutProps) {
  const navigate = useNavigate();
  const { data: pages, isLoading, error, refetch: refetchPages } = useWikiPages(slug);
  const deletePage = useDeleteWikiPage(slug);

  const [newPageModal, setNewPageModal] = useState<{ isOpen: boolean; defaultParentId: string | null }>({
    isOpen: false,
    defaultParentId: null,
  });
  const [renameModal, setRenameModal] = useState<{ isOpen: boolean; page: WikiPageMeta | null }>({
    isOpen: false,
    page: null,
  });
  const [moveModal, setMoveModal] = useState<{ isOpen: boolean; page: WikiPageMeta | null }>({
    isOpen: false,
    page: null,
  });
  const [deleteConfirm, setDeleteConfirm] = useState<WikiPageMeta | null>(null);

  const openNewPage = useCallback(
    (defaultParentId: string | null) => setNewPageModal({ isOpen: true, defaultParentId }),
    []
  );

  const handleDelete = useCallback(() => {
    if (!deleteConfirm) return;
    deletePage.mutate(deleteConfirm.slug);
    if (deleteConfirm.slug === activePageSlug) {
      navigate({ to: "/$slug/wiki", params: { slug } });
    }
    setDeleteConfirm(null);
  }, [deleteConfirm, activePageSlug, slug, deletePage, navigate]);

  const contextMenu = useWikiPageContextMenu(pages, {
    onAddChild: (pageId) => openNewPage(pageId),
    onRename: (page) => setRenameModal({ isOpen: true, page }),
    onMove: (page) => setMoveModal({ isOpen: true, page }),
    onDelete: (page) => setDeleteConfirm(page),
  });

  // Unified sidebar mechanic: desktop intent persists in localStorage, mobile
  // open is ephemeral, and the 768px breakpoint is live in both directions.
  const { open, toggle, overlayActive } = useSidebarState({
    storageKey: "lexa.wiki.sidebar",
    defaultOpen: true,
  });
  const panelRef = useRef<HTMLElement | null>(null);
  useOverlayFocusTrap(overlayActive, panelRef);

  // Tree + search state lives here so collapsing to the rail (which unmounts
  // the sidebar) never discards the user's expand choices or query.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set((pages ?? []).map((p) => p.id)));
  const expandedInit = useRef((pages?.length ?? 0) > 0);
  const [wikiQuery, setWikiQuery] = useState("");
  const [wikiSearchFocused, setWikiSearchFocused] = useState(false);
  useEffect(() => {
    if (pages && pages.length > 0 && !expandedInit.current) {
      expandedInit.current = true;
      setExpanded(new Set(pages.map((p) => p.id)));
    }
  }, [pages]);

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const closeOnMobile = useCallback(() => {
    // Selecting a page dismisses the mobile overlay only; desktop keeps the
    // tree open across navigation.
    if (overlayActive) toggle();
  }, [overlayActive, toggle]);

  // The top nav's "PanelLeft" button dispatches this event. One toggle flips
  // the active viewport's flag; the trigger's visibility stays CSS-only.
  useEffect(() => {
    window.addEventListener("lexa:toggle-wiki-sidebar", toggle);
    return () => window.removeEventListener("lexa:toggle-wiki-sidebar", toggle);
  }, [toggle]);

  // Esc dismisses the overlay while it is open; desktop never traps Escape.
  useEffect(() => {
    if (!overlayActive) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") toggle();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [overlayActive, toggle]);

  // Body scroll locks only while the mobile overlay is open. Desktop keeps the
  // sidebar inline, so locking there would freeze the page underneath.
  useEffect(() => {
    return lockScroll(overlayActive);
  }, [overlayActive]);

  return (
    <div className="wiki-layout">
      {!open ? (
        <SidebarRail onExpand={toggle} />
      ) : (
        <WikiPageSidebar
          panelRef={panelRef}
          slug={slug}
          activePageSlug={activePageSlug}
          pages={pages}
          isLoading={isLoading}
          error={error}
          onRetryPages={refetchPages}
          contextMenuPageId={contextMenu.menu?.pageId ?? null}
          onContextMenu={contextMenu.open}
          onNewPage={openNewPage}
          onClose={toggle}
          expanded={expanded}
          onToggleExpand={toggleExpanded}
          query={wikiQuery}
          onQueryChange={setWikiQuery}
          searchFocused={wikiSearchFocused}
          onSearchFocusedChange={setWikiSearchFocused}
          onNavigate={closeOnMobile}
        />
      )}
      {overlayActive && (
        <button
          type="button"
          className="wiki-sidebar-backdrop"
          aria-label="Close sidebar"
          onClick={toggle}
        />
      )}

      {contextMenu.menu && (
        <WikiPageContextMenu
          anchor={contextMenu.menu.anchor}
          onAddChild={contextMenu.addChild}
          onRename={contextMenu.rename}
          onMove={contextMenu.move}
          onDelete={contextMenu.remove}
        />
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

      <MovePageModal
        slug={slug}
        isOpen={moveModal.isOpen}
        page={moveModal.page}
        pages={pages ?? []}
        onClose={() => setMoveModal({ isOpen: false, page: null })}
      />

      {deleteConfirm && (
        <WikiDeletePageDialog
          page={deleteConfirm}
          pending={deletePage.isPending}
          onConfirm={handleDelete}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}

      {pages
        ? children(pages, { openNewPage: () => openNewPage(null) })
        : null}
    </div>
  );
}
