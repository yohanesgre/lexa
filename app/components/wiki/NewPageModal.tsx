import { useCallback, useEffect, useMemo, useState, useEffectEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Plus, X } from "lucide-react";
import { useCreateWikiPage } from "../../lib/queries";
import type { WikiPageMeta } from "../../../shared/types";

interface NewPageModalProps {
  slug: string;
  isOpen: boolean;
  onClose: () => void;
  defaultParentId?: string | null;
  pages: WikiPageMeta[];
}

type PageWithDepth = WikiPageMeta & { depth: number };

function buildFlatPages(pages: WikiPageMeta[]): PageWithDepth[] {
  const byParent = new Map<string | null, WikiPageMeta[]>();
  for (const page of pages) {
    const list = byParent.get(page.parentId) ?? [];
    list.push(page);
    byParent.set(page.parentId, list);
  }
  const sort = (list: WikiPageMeta[]) => [...list].toSorted((a, b) => a.position - b.position);
  const result: PageWithDepth[] = [];
  const recurse = (parentId: string | null, depth: number) => {
    for (const page of sort(byParent.get(parentId) ?? [])) {
      result.push({ ...page, depth });
      recurse(page.id, depth + 1);
    }
  };
  recurse(null, 0);
  return result;
}

export function NewPageModal({ slug, isOpen, onClose, defaultParentId, pages }: NewPageModalProps) {
  const navigate = useNavigate();
  const createPage = useCreateWikiPage(slug);
  const isSubmitting = createPage.isPending;

  const [title, setTitle] = useState("");
  const [parentId, setParentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pagesById = useMemo(() => new Map(pages.map((p) => [p.id, p])), [pages]);
  const flatPages = useMemo(() => buildFlatPages(pages), [pages]);

  const resetForm = useCallback((nextParentId: string | null = null) => {
    setTitle("");
    setParentId(nextParentId);
    setError(null);
  }, []);

  const handleClose = useCallback(() => {
    resetForm(parentId);
    onClose();
  }, [parentId, onClose, resetForm]);

  const onEscape = useEffectEvent((event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      handleClose();
    }
  });
  useEffect(() => {
    if (!isOpen) return;
    function handleKeyDown(event: KeyboardEvent) {
      onEscape(event);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    const trimmedTitle = title.trim();

    if (trimmedTitle === "") {
      setError("Title is required");
      return;
    }

    setError(null);

    setSubmitting(true);
    try {
      const page = await createPage.mutateAsync({ title: trimmedTitle, parentId });
      onClose();
      resetForm();
      navigate({ to: "/$slug/wiki/$pageSlug", params: { slug, pageSlug: page.slug } });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create page";
      setError(message);
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <>
      <button type="button" className="dialog-overlay" onClick={handleClose} aria-label="Close" />
      <div className="fixed inset-0 flex items-center justify-center z-[70] pointer-events-none">
        <dialog open
          className="dialog dialog-enter pointer-events-auto p-0"
          style={{ width: 440, maxWidth: "calc(100vw - 48px)" }}
          aria-modal="true"
          aria-labelledby="new-page-title"
        >
          <form onSubmit={handleSubmit}>
            <div className="p-4 flex items-center justify-between">
              <h2 id="new-page-title" className="font-display text-lg font-semibold text-lx-text-primary">
                New page
              </h2>
              <button
                type="button"
                className="btn btn-ghost w-8 h-8 p-0"
                onClick={handleClose}
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
                  <label htmlFor="new-page-title-input" className="prop-label block mb-1.5">
                    Title
                  </label>
                  <input
                    id="new-page-title-input"
                    type="text"
                    className="prop-input w-full"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Page title"
                    autoFocus
                  />
                </div>

                <div>
                  <label htmlFor="new-page-parent" className="prop-label block mb-1.5">
                    Parent
                  </label>
                  <select
                    id="new-page-parent"
                    className="prop-input w-full"
                    value={parentId ?? ""}
                    onChange={(e) => setParentId(e.target.value === "" ? null : e.target.value)}
                  >
                    <option value="">(No parent — root)</option>
                    {flatPages.map((page) => (
                      <option key={page.id} value={page.id}>
                        {"\u00A0".repeat(page.depth * 2)}
                        {page.title}
                      </option>
                    ))}
                  </select>
                </div>

              </div>

              <div className="flex items-center gap-2 mt-4 justify-end">
                <button type="button" className="btn btn-ghost" onClick={handleClose}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={isSubmitting}>
                  <Plus size={14} strokeWidth={1.5} />
                  Create page
                </button>
              </div>
            </div>
          </form>
        </dialog>
      </div>
    </>
  );
}
