import { useRef } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight, MoreHorizontal } from "lucide-react";
import type { WikiPageMeta } from "../../../shared/types";
import { cn } from "../ui/cn";
import type { WikiNode } from "./wiki-tree";

function indentClass(level: number): string | undefined {
  return level > 0 ? `tree-indent-${Math.min(level, 5)}` : undefined;
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

export function TreeItem({
  node,
  level,
  activeSlug,
  slug,
  expanded,
  onToggle,
  onContextMenu,
  onOpenPageMenu,
  contextMenuPageId,
  onNavigate,
  tabbableId,
  onFocus,
}: {
  node: WikiNode;
  level: number;
  activeSlug?: string | undefined;
  slug: string;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onContextMenu: (event: React.MouseEvent, page: WikiPageMeta) => void;
  onOpenPageMenu: (element: HTMLElement, page: WikiPageMeta) => void;
  contextMenuPageId: string | null;
  onNavigate?: (() => void) | undefined;
  tabbableId: string | null;
  onFocus: (id: string) => void;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const isActive = node.slug === activeSlug;
  const isExpanded = expanded.has(node.id);
  const hasChildren = node.children.length > 0;
  const menuOpen = contextMenuPageId === node.id;

  return (
    <>
      <div
        ref={rowRef}
        role="treeitem"
        data-node-id={node.id}
        aria-level={level + 1}
        aria-selected={isActive}
        aria-current={isActive ? "page" : undefined}
        aria-expanded={hasChildren ? isExpanded : undefined}
        tabIndex={node.id === tabbableId ? 0 : -1}
        onFocus={() => onFocus(node.id)}
        onContextMenu={(event) => onContextMenu(event, node)}
        className={cn(
          "tree-item",
          indentClass(level),
          isActive && "active",
          menuOpen && "bg-lx-surface-card-hover"
        )}
      >
        {hasChildren ? (
          <button
            type="button"
            tabIndex={-1}
            onClick={() => onToggle(node.id)}
            className="chevron-small p-0.5 -ml-0.5"
            style={{ transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)" }}
            aria-label={isExpanded ? `Collapse ${node.title}` : `Expand ${node.title}`}
          >
            <ChevronRight size={12} strokeWidth={2} />
          </button>
        ) : null}
        <Link
          to="/$slug/wiki/$pageSlug"
          params={{ slug, pageSlug: node.slug }}
          tabIndex={-1}
          className="tree-item-link"
          onClick={onNavigate}
        >
          <PageIcon className="text-lx-text-muted mr-1.5 shrink-0" />
          <span className="truncate">{node.title}</span>
        </Link>
        {/* Not tabbable, like the chevron: a treeitem owns the row's focus and
            the keyboard opens this same menu with the Context-Menu key or
            Shift+F10. Touch and pointer users get the visible trigger. */}
        <button
          type="button"
          tabIndex={-1}
          className={cn("tree-item-menu icon-btn", menuOpen && "active")}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`Page actions for ${node.title}`}
          onClick={() => {
            const row = rowRef.current;
            if (row) onOpenPageMenu(row, node);
          }}
        >
          <MoreHorizontal size={14} strokeWidth={2} />
        </button>
      </div>
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
            onOpenPageMenu={onOpenPageMenu}
            contextMenuPageId={contextMenuPageId}
            onNavigate={onNavigate}
            tabbableId={tabbableId}
            onFocus={onFocus}
          />
        ))}
    </>
  );
}
