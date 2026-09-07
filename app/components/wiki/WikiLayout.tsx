import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState, useCallback } from "react";
import { PanelLeft } from "lucide-react";
import { lockScroll } from "../../lib/scroll-lock";
import { hasMatchMedia, isNarrowViewport } from "../../lib/viewport";
import { useWikiPages, useDeleteWikiPage } from "../../lib/queries";
import type { WikiPageMeta } from "../../../shared/types";
import { NewPageModal } from "./NewPageModal";
import { WikiPageContextMenu } from "./WikiPageContextMenu";
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
  x: number;
  y: number;
}

// Right-click menu lifecycle: open on contextmenu, dismiss on outside
// mousedown or Escape. Menu + viewport position live in one state object.
function useWikiPageContextMenu(
  pages: WikiPageMeta[] | undefined,
  actions: {
    onAddChild: (pageId: string) => void;
    onRename: (page: WikiPageMeta) => void;
    onDelete: (page: WikiPageMeta) => void;
  }
) {
  const [menu, setMenu] = useState<WikiContextMenuState | null>(null);

  useEffect(() => {
    if (!menu) return;
    function handleMouseDown(event: MouseEvent) {
      const target = event.target as Node;
      if (!target || !(target instanceof Node)) return;
      const menuEl = document.getElementById("wiki-page-context-menu");
      if (menuEl && !menuEl.contains(target)) {
        setMenu(null);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        setMenu(null);
      }
    }
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menu]);

  const open = useCallback((event: React.MouseEvent, page: WikiPageMeta) => {
    event.preventDefault();
    setMenu({
      pageId: page.id,
      pageTitle: page.title,
      pageSlug: page.slug,
      x: event.clientX,
      y: event.clientY,
    });
  }, []);

  const close = useCallback(() => setMenu(null), []);

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

  const remove = useCallback(() => {
    if (!menu || !pages) return;
    const page = pages.find((p) => p.id === menu.pageId);
    if (page) actions.onDelete(page);
    setMenu(null);
  }, [menu, pages, actions]);

  return { menu, open, close, addChild, rename, remove };
}

function SidebarRail({ onExpand }: { onExpand: () => void }) {
  return (
    <aside className="wiki-sidebar wiki-sidebar-rail">
      <button
        type="button"
        className="w-7 h-7 p-0 flex items-center justify-center text-lx-text-secondary hover:text-lx-text-primary rounded"
        onClick={onExpand}
        aria-label="Expand sidebar"
        title="Pages"
      >
        <PanelLeft size={14} strokeWidth={1.5} />
      </button>
    </aside>
  );
}

export function WikiLayout({ slug, activePageSlug, children }: WikiLayoutProps) {
  const navigate = useNavigate();
  const { data: pages, isLoading, error } = useWikiPages(slug);
  const deletePage = useDeleteWikiPage(slug);

  const [newPageModal, setNewPageModal] = useState<{ isOpen: boolean; defaultParentId: string | null }>({
    isOpen: false,
    defaultParentId: null,
  });
  const [renameModal, setRenameModal] = useState<{ isOpen: boolean; page: WikiPageMeta | null }>({
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
    onDelete: (page) => setDeleteConfirm(page),
  });

  // Narrow screens start collapsed so the tree never starves the content.
  // Static default (same on server + client); the viewport is read once on
  // mount and the user's manual choice sticks afterwards.
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false);
  useEffect(() => {
    if (isNarrowViewport()) setSidebarCollapsed(true);
  }, []);

  // The top nav's "PanelLeft" button dispatches this event on mobile. We
  // open the sidebar so the user can pick a different page. Desktop
  // behavior is unchanged (the rail remains the entry point there).
  useEffect(() => {
    function handleToggle() {
      if (hasMatchMedia() && isNarrowViewport()) {
        setSidebarCollapsed(false);
      }
    }
    window.addEventListener("lexa:toggle-wiki-sidebar", handleToggle);
    return () => window.removeEventListener("lexa:toggle-wiki-sidebar", handleToggle);
  }, []);

  // Lock body scroll while the wiki sidebar is open.
  useEffect(() => {
    return lockScroll(!sidebarCollapsed);
  }, [sidebarCollapsed]);

  return (
    <div className="wiki-layout">
      {sidebarCollapsed ? (
        <SidebarRail onExpand={() => setSidebarCollapsed(false)} />
      ) : (
        <WikiPageSidebar
          slug={slug}
          activePageSlug={activePageSlug}
          pages={pages}
          isLoading={isLoading}
          error={error}
          contextMenuPageId={contextMenu.menu?.pageId ?? null}
          onContextMenu={contextMenu.open}
          onNewPage={openNewPage}
          onClose={() => setSidebarCollapsed(true)}
        />
      )}

      {contextMenu.menu && (
        <WikiPageContextMenu
          x={contextMenu.menu.x}
          y={contextMenu.menu.y}
          onAddChild={contextMenu.addChild}
          onRename={contextMenu.rename}
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
