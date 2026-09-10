import { Link } from "@tanstack/react-router";
import type { WikiPageMeta } from "../../../shared/types";
import { firstRootPage } from "../../lib/wiki";

interface WikiPageNotFoundProps {
  slug: string;
  pageSlug: string;
  pages?: WikiPageMeta[];
}

export function WikiPageNotFound({ slug, pageSlug, pages = [] }: WikiPageNotFoundProps) {
  const first = firstRootPage(pages);
  return (
    <div className="wiki-content flex items-center justify-center">
      <div style={{ textAlign: "center", maxWidth: 400 }}>
        <div className="flex justify-center mb-3">
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            style={{ color: "var(--lx-text-muted)" }}
          >
            <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="9.5" x2="14.5" y1="12.5" y2="17.5" />
            <line x1="14.5" x2="9.5" y1="12.5" y2="17.5" />
          </svg>
        </div>

        <h2 className="font-display text-xl font-semibold text-lx-text-primary mb-2">Page not found</h2>
        <p className="text-sm text-lx-text-secondary mb-2" style={{ lineHeight: "20px" }}>
          This page may have been moved, renamed, or deleted by a teammate.
        </p>

        <div className="flex justify-center mb-4">
          <span
            className="font-mono text-xs text-lx-text-muted bg-lx-surface-input border border-lx-border rounded-sm"
            style={{ padding: "4px 8px" }}
          >
            /wiki/{pageSlug}
          </span>
        </div>

        <div className="flex items-center justify-center gap-2">
          {first && (
            <Link to="/$slug/wiki/$pageSlug" params={{ slug, pageSlug: first.slug }} className="btn btn-primary">
              Go to first page
            </Link>
          )}
          <Link to="/$slug/wiki" params={{ slug }} className="btn btn-ghost">
            Search wiki
          </Link>
        </div>
      </div>
    </div>
  );
}
