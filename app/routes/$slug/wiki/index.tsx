import { createFileRoute } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { WikiLayout } from "../../../components/wiki/WikiLayout";

export const Route = createFileRoute("/$slug/wiki/")({
  component: WikiIndexPage,
});

function FileIcon({ className }: { className?: string }) {
  return (
    <svg
      width="24"
      height="24"
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

function WikiEmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex items-center justify-center h-full">
      <div
        className="text-center"
        style={{
          maxWidth: 380,
          border: "1px dashed var(--lx-border-strong)",
          borderRadius: 12,
          padding: "56px 40px",
        }}
      >
        <div className="flex justify-center mb-3">
          <FileIcon className="text-lx-text-muted" />
        </div>
        <h2 className="font-display text-xl font-semibold text-lx-text-primary mb-2">
          No pages yet
        </h2>
        <p className="text-sm text-lx-text-secondary mb-4 leading-5">
          The wiki is where design docs, combat formulas, and art direction live. Pages can be nested to mirror how your team thinks.
        </p>
        <button type="button" className="btn btn-primary" onClick={onCreate}>
          <Plus size={14} strokeWidth={1.5} />
          Create the first page
        </button>
      </div>
    </div>
  );
}

function WikiIndexPage() {
  const { slug } = Route.useParams();
  return (
    <WikiLayout slug={slug}>
      {(pages, { openNewPage }) => {
        if (pages.length === 0) {
          return <WikiEmptyState onCreate={openNewPage} />;
        }
        return (
          <div className="flex items-center justify-center h-full text-lx-text-muted">
            <div className="text-center">
              <p className="text-sm">Select a page from the sidebar to start reading.</p>
            </div>
          </div>
        );
      }}
    </WikiLayout>
  );
}
