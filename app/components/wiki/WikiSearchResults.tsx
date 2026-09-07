import { Link } from "@tanstack/react-router";
import type { WikiPageMeta } from "../../../shared/types";

function padCount(n: number): string {
  return String(n).padStart(3, "0");
}

function getBreadcrumb(pagesById: Map<string, WikiPageMeta>, page: WikiPageMeta): string[] {
  const path: string[] = [];
  let current: WikiPageMeta | null = page;
  while (current) {
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
      return <mark key={part}>{part.slice(2, -2)}</mark>;
    }
    return <span key={part}>{part}</span>;
  });
}

function SearchResult({
  slug,
  result,
  breadcrumb,
}: {
  slug: string;
  result: WikiPageMeta & { snippet: string };
  breadcrumb: string[];
}) {
  return (
    <Link
      to="/$slug/wiki/$pageSlug"
      params={{ slug, pageSlug: result.slug }}
      className="search-result"
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

export function WikiSearchResults({
  results,
  searching,
  slug,
  pagesById,
}: {
  results: (WikiPageMeta & { snippet: string })[];
  searching: boolean;
  slug: string;
  pagesById: Map<string, WikiPageMeta>;
}) {
  return (
    <>
      <div className="px-4 mb-2 flex items-center justify-between">
        <span className="font-micro text-2xs uppercase tracking-[0.04em] text-lx-text-muted">
          {padCount(results.length)} Results
        </span>
      </div>
      {searching && (
        <div className="px-4 text-xs text-lx-text-muted py-2">Searching…</div>
      )}
      {!searching && results.length === 0 && (
        <div className="px-4 text-xs text-lx-text-muted py-2">No results found.</div>
      )}
      {results.map((result) => (
        <SearchResult
          key={result.id}
          slug={slug}
          result={result}
          breadcrumb={getBreadcrumb(pagesById, result)}
        />
      ))}
    </>
  );
}
