import { useEffect, useMemo, useState } from "react";
import { ChevronRight, PanelRight } from "lucide-react";
import { cn } from "../ui/cn";
import type { HeadingOutline } from "../tiptap-render";

interface OutlineSidebarProps {
  headings: HeadingOutline[];
  collapsed?: boolean | undefined;
  onToggle?: () => void;
}

interface TreeNode {
  key: string;
  title: string;
  children: TreeNode[];
  level: number;
}

function toTree(headings: HeadingOutline[]): TreeNode[] {
  if (headings.length === 0) return [];
  const root: TreeNode[] = [];
  const stack: TreeNode[] = [];
  for (const h of headings) {
    while (stack.length > 0) {
      const parent = stack[stack.length - 1];
      // @ts-expect-error — strict: exactOptional indexedAccess
      if (parent.level < h.level!) break;
      stack.pop();
    }
    const node: TreeNode = { key: h.id, title: h.text, children: [], level: h.level };
    if (stack.length === 0) {
      root.push(node);
    } else {
      // @ts-expect-error — strict: exactOptional indexedAccess
      stack[stack.length - 1!].children.push(node);
    }
    stack.push(node);
  }
  return root;
}

const INDENT = 16;

// Keys of every node that has children — these render expanded (the
// wireframe shows the outline tree fully expanded by default). Shared by the
// lazy useState initializer and the tree-change sync so mount behaves exactly
// like every subsequent update.
function collectExpandedKeys(nodes: TreeNode[]): Set<string> {
  const all = new Set<string>();
  function walk(list: TreeNode[]) {
    for (const n of list) {
      if (n.children.length > 0) {
        all.add(n.key);
        walk(n.children);
      }
    }
  }
  walk(nodes);
  return all;
}

function TreeItems({
  nodes,
  depth,
  activeId,
  expandedKeys,
  onToggleExpand,
  onClick,
}: {
  nodes: TreeNode[];
  depth: number;
  activeId: string;
  expandedKeys: Set<string>;
  onToggleExpand: (key: string) => void;
  onClick: (node: TreeNode) => void;
}) {
  return (
    <>
      {nodes.map((node) => {
        const isActive = activeId === node.key;
        const hasChildren = node.children.length > 0;
        const isExpanded = expandedKeys.has(node.key);
        return (
          <div key={node.key}>
            <a
              href={`#${node.key}`}
              onClick={(e) => {
                e.preventDefault();
                onClick(node);
                const el = document.getElementById(node.key);
                if (el) el.scrollIntoView({ behavior: "smooth" });
              }}
              className={cn(
                "flex items-center h-8 text-sm font-body cursor-pointer select-none",
                isActive
                  ? "text-lx-text-primary font-medium bg-lx-surface-selected border-l-2 border-lx-border-focus"
                  : "text-lx-text-secondary font-normal border-l-2 border-transparent hover:bg-lx-surface-card-hover"
              )}
              style={{ paddingLeft: 12 + depth * INDENT, paddingRight: 12 }}
            >
              {hasChildren ? (
                <button
                  type="button"
                  aria-label="Toggle section"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onToggleExpand(node.key);
                  }}
                  className="w-4 h-4 flex items-center justify-center mr-1 flex-shrink-0 text-lx-text-muted"
                >
                  <ChevronRight
                    size={14}
                    strokeWidth={1.5}
                    style={{
                      transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)",
                      transition: "transform 0.15s",
                    }}
                  />
                </button>
              ) : (
                <span className="w-4 h-4 mr-1 flex-shrink-0" />
              )}
              {node.title}
            </a>
            {hasChildren && isExpanded && (
              <TreeItems
                nodes={node.children}
                depth={depth + 1}
                activeId={activeId}
                expandedKeys={expandedKeys}
                onToggleExpand={onToggleExpand}
                onClick={onClick}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

export function OutlineSidebar({ headings, collapsed, onToggle }: OutlineSidebarProps) {
  const [activeId, setActiveId] = useState<string>("");
  const tree = useMemo(() => toTree(headings), [headings]);
  // Lazy-init from the initial tree: sections start EXPANDED on first mount,
  // identical to the tree-change sync below (mount == update == wireframe).
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => collectExpandedKeys(tree));

  const [prevTree, setPrevTree] = useState(tree);
  if (prevTree !== tree) {
    setPrevTree(tree);
    setExpandedKeys(collectExpandedKeys(tree));
  }

  useEffect(() => {
    if (headings.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
          }
        }
      },
      { rootMargin: "-80px 0px -70% 0px", threshold: 0 }
    );

    const observed = new Set<string>();
    for (const h of headings) {
      const el = document.getElementById(h.id);
      if (el && !observed.has(h.id)) {
        observer.observe(el);
        observed.add(h.id);
      }
    }

    return () => observer.disconnect();
  }, [headings]);

  // Persistent third column — pages without headings show an empty state
  // instead of collapsing the layout back to two columns.
  const isEmpty = headings.length === 0;
  const isCollapsed = collapsed ?? false;

  if (isCollapsed) {
    return (
      <aside
        className="outline-sidebar outline-sidebar-rail flex-shrink-0 flex flex-col bg-lx-surface-elevated"
        style={{
          width: 36,
          minWidth: 36,
          borderLeft: "1px solid var(--lx-border-default)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          paddingTop: 8,
        }}
      >
        <button
          type="button"
          className="w-7 h-7 p-0 flex items-center justify-center text-lx-text-secondary hover:text-lx-text-primary rounded"
          onClick={onToggle}
          aria-label="Expand sidebar"
          title="Contents"
        >
          <PanelRight size={14} strokeWidth={1.5} />
        </button>
      </aside>
    );
  }

  return (
    <aside
      className="outline-sidebar outline-sidebar-open flex-shrink-0 flex flex-col bg-lx-surface-elevated"
      style={{ width: 220, overflow: "hidden", borderLeft: "1px solid var(--lx-border-default)" }}
    >
      <div className="sidebar-header">
        <button
          type="button"
          className="w-7 h-7 p-0 flex items-center justify-center text-lx-text-secondary hover:text-lx-text-primary flex-shrink-0 rounded"
          onClick={onToggle}
          aria-label="Collapse sidebar"
        >
          <PanelRight size={14} strokeWidth={1.5} />
        </button>
        <span className="text-xs font-medium font-body uppercase tracking-[0.05em] text-lx-text-secondary">Contents</span>
      </div>
      <div className="flex-1 overflow-y-auto" style={{ padding: "8px 0" }}>
        {isEmpty ? (
          <div className="px-4 py-3 text-xs text-lx-text-muted">No headings yet</div>
        ) : (
          <TreeItems
            nodes={tree}
            depth={0}
            activeId={activeId}
            expandedKeys={expandedKeys}
            onToggleExpand={(key) =>
              setExpandedKeys((prev) => {
                const next = new Set(prev);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              })
            }
            onClick={(node) => setActiveId(node.key)}
          />
        )}
      </div>
    </aside>
  );
}