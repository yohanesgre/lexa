import { Link } from "@tanstack/react-router";
import { AlertCircle, Search } from "lucide-react";
import type { WikiPageMeta } from "../../../shared/types";

function padCount(n: number): string {
  return String(n).padStart(3, "0");
}

function getBreadcrumb(pagesById: Map<string, WikiPageMeta>, page: WikiPageMeta): string[] {
  const path: string[] = [];
  const visited = new Set<string>();
  let current: WikiPageMeta | null = page;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    path.unshift(current.title);
    current = current.parentId ? pagesById.get(current.parentId) ?? null : null;
  }
  path.pop();
  return path;
}

function renderSnippet(snippet: string): React.ReactNode {
  const parts = snippet.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <mark key={index}>{part.slice(2, -2)}</mark>;
    }
    return <span key={index}>{part}</span>;
  });
}

function SearchResult({
  slug,
  result,
  breadcrumb,
  onNavigate,
}: {
  slug: string;
  result: WikiPageMeta & { snippet: string };
  breadcrumb: string[];
  onNavigate?: (() => void) | undefined;
}) {
  return (
    <Link
      to="/$slug/wiki/$pageSlug"
      params={{ slug, pageSlug: result.slug }}
      className="search-result"
      onClick={onNavigate}
    >
      {breadcrumb.length > 0 && (
        <div className="text-xs text-lx-text-muted font-body mb-1 truncate">
          {breadcrumb.join(" / ")}
        </div>
      )}
      <div className="text-sm font-medium text-lx-text-primary font-body">{result.title}</div>
      <div className="text-xs text-lx-text-secondary font-body mt-1 search-result-snippet">
        {renderSnippet(result.snippet)}
      </div>
    </Link>
  );
}

function CountRow({ label }: { label: string }) {
  return (
    <div className="px-4 mb-2 flex items-center justify-between">
      <span
        className="font-micro text-2xs uppercase tracking-[0.04em] text-lx-text-muted"
        role="status"
        aria-live="polite"
      >
        {label}
      </span>
    </div>
  );
}

function SearchingState() {
  return (
    <>
      <CountRow label="Searching…" />
      <div className="px-4">
        <div className="skeleton" style={{ height: 9, width: "72%", marginBottom: 10 }} />
        <div className="skeleton" style={{ height: 9, width: "94%", marginBottom: 10 }} />
        <div className="skeleton" style={{ height: 9, width: "80%", marginBottom: 16 }} />
        <div className="skeleton" style={{ height: 9, width: "60%", marginBottom: 10 }} />
        <div className="skeleton" style={{ height: 9, width: "88%", marginBottom: 10 }} />
      </div>
    </>
  );
}

function NoResultsState({ query }: { query: string }) {
  return (
    <>
      <CountRow label={`${padCount(0)} Results`} />
      <div className="empty-state" style={{ padding: 24, flex: 1 }}>
        <div className="empty-state-icon">
          <Search />
        </div>
        <span className="text-sm font-medium text-lx-text-primary font-body mb-1">
          No results for “{query}”
        </span>
        <span className="text-xs text-lx-text-secondary font-body" style={{ lineHeight: 18, maxWidth: 200 }}>
          Try a shorter term or check the spelling.
        </span>
      </div>
    </>
  );
}

function SearchErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <>
      <CountRow label="Search unavailable" />
      <div className="px-3" style={{ flex: 1 }}>
        <div className="card-panel card-panel--danger" style={{ padding: "12px 14px" }}>
          <div className="flex items-center gap-2 mb-1">
            <AlertCircle size={14} strokeWidth={1.5} className="text-lx-text-danger flex-shrink-0" />
            <span className="text-sm font-medium text-lx-text-primary font-body">Couldn’t search</span>
          </div>
          <span className="text-xs text-lx-text-secondary font-body" style={{ lineHeight: 18 }}>
            The search index didn’t respond.
          </span>
          <div className="mt-2">
            <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
              Retry
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

export function WikiSearchResults({
  query,
  results,
  searching,
  error,
  slug,
  pagesById,
  onNavigate,
  onRetry,
}: {
  query: string;
  results: (WikiPageMeta & { snippet: string })[];
  searching: boolean;
  error: boolean;
  slug: string;
  pagesById: Map<string, WikiPageMeta>;
  onNavigate?: (() => void) | undefined;
  onRetry: () => void;
}) {
  if (error) return <SearchErrorState onRetry={onRetry} />;
  if (searching) return <SearchingState />;
  if (results.length === 0) return <NoResultsState query={query} />;

  return (
    <>
      <CountRow label={`${padCount(results.length)} Results`} />
      {results.map((result) => (
        <SearchResult
          key={result.id}
          slug={slug}
          result={result}
          breadcrumb={getBreadcrumb(pagesById, result)}
          onNavigate={onNavigate}
        />
      ))}
    </>
  );
}
