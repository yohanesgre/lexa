import { useEffect, useMemo, useState } from "react";
import { Tree } from "antd";
import type { TreeDataNode } from "antd";
import { DownOutlined } from "@ant-design/icons";
import { WikiSidebar } from "./WikiSidebar";
import type { HeadingOutline } from "../tiptap-render";

interface OutlineSidebarProps {
  headings: HeadingOutline[];
  collapsed?: boolean;
  onToggle?: () => void;
}

function toTreeData(headings: HeadingOutline[]): TreeDataNode[] {
  if (headings.length === 0) return [];
  const root: TreeDataNode[] = [];
  const stack: TreeDataNode[] = [];
  for (const h of headings) {
    while (stack.length > 0) {
      const parent = stack[stack.length - 1];
      const parentLevel = Number(String(parent.key).split(":")[1]) || 1;
      if (parentLevel < h.level) break;
      stack.pop();
    }
    const node: TreeDataNode = {
      title: h.text,
      key: h.id,
      children: [],
      isLeaf: true,
    };
    if (stack.length === 0) {
      root.push(node);
    } else {
      const parent = stack[stack.length - 1];
      if (!parent.children) parent.children = [];
      parent.isLeaf = false;
      parent.children.push(node);
    }
    stack.push(node);
  }
  return root;
}

export function OutlineSidebar({ headings, collapsed, onToggle }: OutlineSidebarProps) {
  const [activeId, setActiveId] = useState<string>("");
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  const treeData = useMemo(() => toTreeData(headings), [headings]);

  useEffect(() => {
    const keys: string[] = [];
    function walk(nodes: TreeDataNode[]) {
      for (const n of nodes) {
        if (n.children && n.children.length > 0) {
          keys.push(String(n.key));
          walk(n.children);
        }
      }
    }
    walk(treeData);
    setExpandedKeys(keys);
  }, [treeData]);

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
      <div className="outline-tree flex-1 overflow-y-auto">
        <Tree
          showLine
          switcherIcon={({ expanded }: { expanded?: boolean }) => (
            <DownOutlined
              style={{
                fontSize: 10,
                transform: `rotate(${expanded ? 0 : -90}deg)`,
                transition: "transform 0.2s",
              }}
            />
          )}
          treeData={treeData}
          selectedKeys={activeId ? [activeId] : []}
          expandedKeys={expandedKeys}
          onExpand={(keys) => setExpandedKeys(keys as string[])}
          showIcon={false}
          selectable
          motion={false}
          blockNode
          styles={{
            root: {
              background: "transparent",
              fontFamily: "var(--lx-font-body)",
              fontSize: 13,
              color: "var(--lx-text-secondary)",
              padding: "12px 0 8px 0",
            },
            item: {
              minHeight: 32,
            },
            itemTitle: {
              minHeight: 32,
              display: "flex",
              alignItems: "center",
              padding: "0 12px 0 6px",
              borderRadius: 0,
              color: "var(--lx-text-secondary)",
              fontSize: 13,
              fontWeight: 400,
            },
            itemSwitcher: {
              width: 16,
              minWidth: 16,
              height: 32,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--lx-text-muted)",
              lineHeight: 0,
            },
          }}
        />
      </div>
    </WikiSidebar>
  );
}
