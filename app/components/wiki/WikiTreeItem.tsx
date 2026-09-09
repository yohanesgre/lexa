import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import type { WikiPageMeta } from "../../../shared/types";
import { cn } from "../ui/cn";
import type { WikiNode } from "./wiki-tree";

const indentPadding: Record<number, number> = {
  0: 12,
  1: 28,
  2: 44,
  3: 60,
  4: 76,
  5: 92,
};

function getIndentPadding(level: number, isActive: boolean): number {
  const base = indentPadding[level] ?? indentPadding[5]!;
  return isActive ? base - 2 : base;
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
  contextMenuPageId,
  onNavigate,
}: {
  node: WikiNode;
  level: number;
  activeSlug?: string | undefined;
  slug: string;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onContextMenu: (event: React.MouseEvent, page: WikiPageMeta) => void;
  contextMenuPageId: string | null;
  onNavigate?: (() => void) | undefined;
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
          marginLeft: isActive ? 6 : undefined,
        }}
        onClick={onNavigate}
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
            onNavigate={onNavigate}
          />
        ))}
    </>
  );
}
