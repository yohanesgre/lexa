import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Plus, RefreshCw, X } from "lucide-react";
import { useCreateWikiPage } from "../../lib/queries";
import type { WikiPageMeta } from "../../../shared/types";

interface NewPageModalProps {
  slug: string;
  isOpen: boolean;
  onClose: () => void;
  defaultParentId?: string | null;
  pages: WikiPageMeta[];
}

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "page"
  );
}

function isValidSlug(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 60;
}

type PageWithDepth = WikiPageMeta & { depth: number };

function buildFlatPages(pages: WikiPageMeta[]): PageWithDepth[] {
  const byParent = new Map<string | null, WikiPageMeta[]>();
  for (const page of pages) {
    const list = byParent.get(page.parentId) ?? [];
    list.push(page);
    byParent.set(page.parentId, list);
  }
  const sort = (list: WikiPageMeta[]) => [...list].sort((a, b) => a.position - b.position);
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

function getParentPrefix(pagesById: Map<string, WikiPageMeta>, parentId: string | null): string {
  const slugs: string[] = [];
  let currentId: string | null = parentId;
  while (currentId) {
    const page = pagesById.get(currentId);
    if (!page) break;
    slugs.unshift(page.slug);
    currentId = page.parentId;
  }
  return slugs.length > 0 ? `/wiki/${slugs.join("/")}/` : "/wiki/";
}

export function NewPageModal({ slug, isOpen, onClose, defaultParentId, pages }: NewPageModalProps) {
  const navigate = useNavigate();
  const createPage = useCreateWikiPage(slug);
  const isSubmitting = createPage.isPending;

  const [title, setTitle] = useState("");
  const [parentId, setParentId] = useState<string | null>(null);
  const [pageSlug, setPageSlug] = useState("");
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pagesById = useMemo(() => new Map(pages.map((p) => [p.id, p])), [pages]);
  const flatPages = useMemo(() => buildFlatPages(pages), [pages]);

  const resetForm = useCallback((nextParentId: string | null = null) => {
    setTitle("");
    setParentId(nextParentId);
    setPageSlug("");
    setSlugManuallyEdited(false);
    setError(null);
  }, []);

  const handleClose = useCallback(() => {
    resetForm(parentId);
    onClose();
  }, [parentId, onClose, resetForm]);

  useEffect(() => {
    if (!isOpen) return;
    const resolvedParent = defaultParentId && pagesById.has(defaultParentId) ? defaultParentId : null;
    resetForm(resolvedParent);
  }, [isOpen, defaultParentId, pagesById, resetForm]);

  useEffect(() => {
    if (slugManuallyEdited) return;
    setPageSlug(slugify(title));
  }, [title, slugManuallyEdited]);

  useEffect(() => {
    if (!isOpen) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        handleClose();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, handleClose]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedTitle = title.trim();
    const trimmedSlug = pageSlug.trim();

    if (trimmedTitle === "") {
      setError("Title is required");
      return;
    }
    if (trimmedSlug === "") {
      setError("Slug is required");
      return;
    }
    if (!isValidSlug(trimmedSlug)) {
      setError("Slug must be lowercase letters, numbers, and hyphens only");
      return;
    }

    setError(null);

    try {
      const page = await createPage.mutateAsync({ title: trimmedTitle, parentId, slug: trimmedSlug });
      onClose();
      resetForm();
      navigate({ to: "/$slug/wiki/$pageSlug", params: { slug, pageSlug: page.slug } });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create page";
      setError(message);
    }
  };

  const handleRegenerateSlug = () => {
    setPageSlug(slugify(title));
    setSlugManuallyEdited(false);
  };

  const parentPrefix = getParentPrefix(pagesById, parentId);

  if (!isOpen) return null;

  return (
    <>
      <div className="dialog-overlay" onClick={handleClose} />
      <div className="fixed inset-0 flex items-center justify-center z-[70] pointer-events-none">
        <div
          className="dialog dialog-enter pointer-events-auto p-0"
          style={{ width: 440, maxWidth: "calc(100vw - 48px)" }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="new-page-title"
        >
          <form onSubmit={handleSubmit}>
            <div className="h-14 px-4 border-b border-lx-border-subtle flex items-center justify-between">
              <h2 id="new-page-title" className="font-display text-base font-medium text-lx-text-primary">
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

                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label htmlFor="new-page-slug" className="prop-label">
                      Slug
                    </label>
                    <button
                      type="button"
                      onClick={handleRegenerateSlug}
                      className="inline-flex items-center justify-center w-5 h-5 rounded text-lx-text-muted hover:text-lx-text-primary"
                      aria-label="Regenerate slug from title"
                      title="Regenerate slug from title"
                    >
                      <RefreshCw size={12} strokeWidth={1.5} />
                    </button>
                  </div>
                  <div className="flex items-center flex-wrap min-h-[32px] px-2.5 py-1 rounded-sm border border-lx-border-default bg-lx-surface-input font-mono text-xs">
                    <span className="text-lx-text-muted select-none">{parentPrefix}</span>
                    <input
                      id="new-page-slug"
                      type="text"
                      value={pageSlug}
                      onChange={(e) => {
                        setPageSlug(e.target.value);
                        setSlugManuallyEdited(true);
                      }}
                      className="bg-transparent border-0 outline-none p-0 m-0 font-mono text-xs text-lx-text-link min-w-[80px] flex-1"
                      aria-label="Slug segment"
                    />
                  </div>
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
        </div>
      </div>
    </>
  );
}
