import { useEffect, useMemo, useState } from "react";
import { FolderInput, Pencil, Plus, Trash2, X } from "lucide-react";
import { useUpdateWikiPage } from "../../lib/queries";
import type { WikiPageMeta } from "../../../shared/types";

interface WikiPageContextMenuProps {
  x: number;
  y: number;
  onAddChild: () => void;
  onRename: () => void;
  onMove: () => void;
  onDelete: () => void;
}

export function WikiPageContextMenu({ x, y, onAddChild, onRename, onMove, onDelete }: WikiPageContextMenuProps) {
  return (
    <div
      id="wiki-page-context-menu"
      className="menu"
      style={{ left: x, top: y }}
      role="menu"
    >
      <button type="button" className="menu-item" onClick={onAddChild} role="menuitem">
        <Plus size={14} strokeWidth={1.5} />
        Add child page
      </button>
      <button type="button" className="menu-item" onClick={onRename} role="menuitem">
        <Pencil size={14} strokeWidth={1.5} />
        Rename
      </button>
      <button type="button" className="menu-item" onClick={onMove} role="menuitem">
        <FolderInput size={14} strokeWidth={1.5} />
        Move
      </button>
      <div className="menu-separator" />
      <button type="button" className="menu-item danger" onClick={onDelete} role="menuitem">
        <Trash2 size={14} strokeWidth={1.5} />
        Delete
      </button>
    </div>
  );
}

type PageOption = WikiPageMeta & { depth: number };

// A page can never be reparented under itself or one of its descendants.
function collectDescendants(pages: WikiPageMeta[], rootId: string): Set<string> {
  const childrenByParent = new Map<string, WikiPageMeta[]>();
  for (const page of pages) {
    if (!page.parentId) continue;
    const list = childrenByParent.get(page.parentId) ?? [];
    list.push(page);
    childrenByParent.set(page.parentId, list);
  }
  const excluded = new Set<string>([rootId]);
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const child of childrenByParent.get(id) ?? []) {
      if (!excluded.has(child.id)) {
        excluded.add(child.id);
        stack.push(child.id);
      }
    }
  }
  return excluded;
}

function buildParentOptions(pages: WikiPageMeta[], excluded: Set<string>): PageOption[] {
  const byParent = new Map<string | null, WikiPageMeta[]>();
  for (const page of pages) {
    const list = byParent.get(page.parentId) ?? [];
    list.push(page);
    byParent.set(page.parentId, list);
  }
  const sort = (list: WikiPageMeta[]) => [...list].toSorted((a, b) => a.position - b.position);
  const result: PageOption[] = [];
  const recurse = (parentId: string | null, depth: number) => {
    for (const page of sort(byParent.get(parentId) ?? [])) {
      if (excluded.has(page.id)) continue;
      result.push({ ...page, depth });
      recurse(page.id, depth + 1);
    }
  };
  recurse(null, 0);
  return result;
}

interface MovePageModalProps {
  slug: string;
  isOpen: boolean;
  page: WikiPageMeta | null;
  pages: WikiPageMeta[];
  onClose: () => void;
}

// wireframes/src/wiki-page-menu.html: Move reparents a page. No dedicated
// wireframe dialog exists; this reuses the NewPageModal parent-picker pattern
// and the existing PATCH /wiki/pages/:pageSlug endpoint (parentId).
export function MovePageModal({ slug, isOpen, page, pages, onClose }: MovePageModalProps) {
  const update = useUpdateWikiPage(slug);
  const [parentId, setParentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && page) {
      setParentId(page.parentId);
      setError(null);
    }
  }, [isOpen, page]);

  useEffect(() => {
    if (!isOpen) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  const excluded = useMemo(
    () => (page ? collectDescendants(pages, page.id) : new Set<string>()),
    [page, pages]
  );
  const options = useMemo(() => buildParentOptions(pages, excluded), [pages, excluded]);

  if (!isOpen || !page) return null;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (update.isPending) return;
    if (parentId === page.parentId) {
      onClose();
      return;
    }
    setError(null);
    try {
      await update.mutateAsync({ pageSlug: page.slug, parentId });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to move page");
    }
  };

  return (
    <>
      <button type="button" className="dialog-overlay" onClick={onClose} aria-label="Close" />
      <div className="fixed inset-0 flex items-center justify-center z-[70] pointer-events-none">
        <dialog
          open
          className="dialog dialog-enter pointer-events-auto p-0"
          style={{ width: 440, maxWidth: "calc(100vw - 48px)" }}
          aria-modal="true"
          aria-labelledby="move-page-title"
        >
          <form onSubmit={handleSubmit}>
            <div className="p-4 flex items-center justify-between">
              <h2 id="move-page-title" className="font-display text-lg font-semibold text-lx-text-primary">
                Move page
              </h2>
              <button
                type="button"
                className="btn btn-ghost w-8 h-8 p-0"
                onClick={onClose}
                aria-label="Close"
              >
                <X size={18} strokeWidth={1.5} />
              </button>
            </div>

            <div className="p-4">
              {error && (
                <div className="text-sm text-lx-text-danger mb-4 bg-lx-bg-danger-subtle rounded-md px-3 py-2">
                  {error}
                </div>
              )}

              <div className="flex flex-col gap-4">
                <div>
                  <span className="text-sm text-lx-text-secondary">
                    Moving <span className="font-medium text-lx-text-primary">{page.title}</span>
                  </span>
                </div>
                <div>
                  <label htmlFor="move-page-parent" className="prop-label block mb-1.5">
                    Parent
                  </label>
                  <select
                    id="move-page-parent"
                    className="prop-input w-full"
                    value={parentId ?? ""}
                    onChange={(e) => setParentId(e.target.value === "" ? null : e.target.value)}
                  >
                    <option value="">(No parent — root)</option>
                    {options.map((option) => (
                      <option key={option.id} value={option.id}>
                        {"\u00A0".repeat(option.depth * 2)}
                        {option.title}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex items-center gap-2 mt-4 justify-end">
                <button type="button" className="btn btn-ghost" onClick={onClose} disabled={update.isPending}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={update.isPending}>
                  <FolderInput size={14} strokeWidth={1.5} />
                  Move
                </button>
              </div>
            </div>
          </form>
        </dialog>
      </div>
    </>
  );
}
