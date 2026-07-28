import { useEffect, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "../ui/cn";
import { WikiSidebar } from "./WikiSidebar";
import type { HeadingOutline } from "../tiptap-render";

interface OutlineSidebarProps {
  headings: HeadingOutline[];
  collapsed?: boolean;
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
      if (parent.level < h.level) break;
      stack.pop();
    }
    const node: TreeNode = { key: h.id, title: h.text, children: [], level: h.level };
    if (stack.length === 0) {
      root.push(node);
    } else {
      stack[stack.length - 1].children.push(node);
    }
    stack.push(node);
  }
  return root;
}

const INDENT = 16;

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
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const tree = useMemo(() => toTree(headings), [headings]);

  useEffect(() => {
    const all = new Set<string>();
    function walk(nodes: TreeNode[]) {
      for (const n of nodes) {
        if (n.children.length > 0) {
          all.add(n.key);
          walk(n.children);
        }
      }
    }
    walk(tree);
    setExpandedKeys(all);
  }, [tree]);

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

  if (headings.length === 0) return null;

  return (
    <WikiSidebar title="Contents" collapsed={collapsed ?? false} onToggle={onToggle ?? (() => {})} width={220}>
      <div className="flex-1 overflow-y-auto" style={{ padding: "8px 0" }}>
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
      </div>
    </WikiSidebar>
  );
}
