import { useEffect, useState } from "react";
import { Save, X } from "lucide-react";
import { useUpdateWikiPage } from "../../lib/queries";
import type { WikiPageMeta } from "../../../shared/types";

interface RenamePageModalProps {
  slug: string;
  page: WikiPageMeta | null;
  isOpen: boolean;
  onClose: () => void;
}

export function RenamePageModal({ slug, page, isOpen, onClose }: RenamePageModalProps) {
  const updatePage = useUpdateWikiPage(slug);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    if (page) {
      setTitle(page.title);
    } else {
      setTitle("");
    }
    setError(null);
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

  if (!isOpen || !page) return null;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedTitle = title.trim();

    if (trimmedTitle === "") {
      setError("Title is required");
      return;
    }

    setError(null);

    try {
      await updatePage.mutateAsync({ pageSlug: page.slug, title: trimmedTitle });
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to rename page";
      setError(message);
    }
  };

  return (
    <>
      <div className="dialog-overlay" onClick={onClose} />
      <div className="fixed inset-0 flex items-center justify-center z-[70] pointer-events-none">
        <div
          className="dialog dialog-enter pointer-events-auto p-0"
          style={{ width: 440, maxWidth: "calc(100vw - 48px)" }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="rename-page-title"
        >
          <form onSubmit={handleSubmit}>
            <div className="h-14 px-4 border-b border-lx-border-subtle flex items-center justify-between">
              <h2 id="rename-page-title" className="font-display text-base font-medium text-lx-text-primary">
                Rename page
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
                  <label htmlFor="rename-page-title-input" className="prop-label block mb-1.5">
                    Title
                  </label>
                  <input
                    id="rename-page-title-input"
                    type="text"
                    className="prop-input w-full"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Page title"
                    autoFocus
                  />
                </div>

              </div>

              <div className="flex items-center gap-2 mt-4 justify-end">
                <button type="button" className="btn btn-ghost" onClick={onClose}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={updatePage.isPending}>
                  <Save size={14} strokeWidth={1.5} />
                  Save
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </>
  );
}
