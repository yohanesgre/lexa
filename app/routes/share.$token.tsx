import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { renderDoc } from "../components/tiptap-render";
import type { TipTapDoc } from "../../shared/types";

interface SharedPageNode {
  id: string;
  title: string;
  slug: string;
  content: TipTapDoc | Record<string, never>;
  updatedAt: string;
  children: SharedPageNode[];
}

interface SharedTree {
  root: SharedPageNode;
}

// Plain fetch — the token IS the credential; the keyed API client must not
// attach an Authorization header to this surface. Total: any failure
// (network error, malformed body) resolves to null → dead-link state.
export async function fetchSharedTree(token: string): Promise<SharedTree | null> {
  try {
    const res = await fetch(`/api/share/${encodeURIComponent(token)}`);
    if (!res.ok) return null;
    return (await res.json()) as SharedTree;
  } catch {
    return null;
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const fileIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} style={{ color: "var(--lx-text-muted)", flexShrink: 0 }}>
    <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
    <polyline points="14 2 14 8 20 8" />
  </svg>
);

export function SharedWikiPage({ tree, token, pageId, onSelectPage }: { tree: SharedTree | null; token: string; pageId?: string; onSelectPage?: (id: string) => void }) {
  const [currentId, setCurrentId] = useState<string | null>(null);

  if (!tree) {
    return (
      <main style={{ maxWidth: 720, margin: "0 auto", padding: "48px 24px" }}>
        <div className="empty-box">
          <div className="flex justify-center mb-3">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} style={{ color: "var(--lx-text-muted)" }}>
              <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="9.5" x2="14.5" y1="12.5" y2="17.5" />
              <line x1="14.5" x2="9.5" y1="12.5" y2="17.5" />
            </svg>
          </div>
          <h2 className="font-display text-xl font-semibold text-lx-text-primary mb-2">Page not available</h2>
          <p className="text-sm text-lx-text-secondary mb-2" style={{ lineHeight: 20, maxWidth: 400 }}>
            This shared link is invalid, has expired, or was revoked by the owner.
          </p>
          <div className="flex justify-center mb-2">
            <span className="font-mono text-xs text-lx-text-muted bg-lx-bg-input border border-lx-border-default rounded-sm" style={{ padding: "4px 8px" }}>
              /share/{token}
            </span>
          </div>
          <p className="text-xs text-lx-text-tertiary" style={{ lineHeight: 18, maxWidth: 420 }}>
            Ask the person who shared this page for a fresh link.
          </p>
        </div>
      </main>
    );
  }

  const byId = new Map<string, SharedPageNode>();
  const walk = (node: SharedPageNode) => {
    byId.set(node.id, node);
    node.children.forEach(walk);
  };
  walk(tree.root);
  // URL param wins over local state so browser Back/Forward and deep links
  // select the right node.
  const current = (pageId && byId.get(pageId)) || (currentId !== null && byId.get(currentId)) || tree.root;
  // Empty pages arrive as content:{} — normalize so renderDoc never sees a
  // doc without a content array.
  const doc: TipTapDoc =
    current.content && typeof current.content === "object" && Array.isArray((current.content as TipTapDoc).content)
      ? (current.content as TipTapDoc)
      : { type: "doc", content: [] };

  return (
    <>
      <meta name="robots" content="noindex" />
      <header
        className="flex items-center justify-between"
        style={{ height: 48, padding: "0 24px", borderBottom: "1px solid var(--lx-border-subtle)" }}
      >
        <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
          {fileIcon}
          <span className="font-display truncate" style={{ fontSize: 16, fontWeight: 500 }}>{current.title}</span>
        </div>
        <span className="status-badge status-badge-empty">Shared read-only</span>
      </header>

      <main style={{ padding: "0 24px 32px" }}>
        <div className="wiki-prose">
          <h1>{current.title}</h1>
          <div>{renderDoc(doc, "wiki")}</div>

          {current.children.length > 0 && (
            <div style={{ marginTop: 32, paddingTop: 16, borderTop: "1px solid var(--lx-border-subtle)" }}>
              <div className="flex items-center gap-2 mb-3">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} style={{ color: "var(--lx-text-muted)" }}>
                  <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                  <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                </svg>
                <span className="text-xs text-lx-text-secondary font-body uppercase tracking-[0.05em]">Child pages</span>
              </div>
              {current.children.map((child) => (
                <button
                  key={child.id}
                  type="button"
                  className="github-issue-row"
                  style={{ display: "flex", width: "100%", maxWidth: 560, textAlign: "left", cursor: "pointer" }}
                  onClick={() => {
                    setCurrentId(child.id);
                    onSelectPage(child.id);
                  }}
                >
                  <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} style={{ color: "var(--lx-text-muted)", flexShrink: 0 }}>
                      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                    <span className="text-sm text-lx-text-primary">{child.title}</span>
                  </div>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} style={{ color: "var(--lx-text-muted)", flexShrink: 0 }}>
                    <path d="M9 18l6-6-6-6" />
                  </svg>
                </button>
              ))}
            </div>
          )}

          <div style={{ marginTop: 32, paddingTop: 16, borderTop: "1px solid var(--lx-border-subtle)" }}>
            <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">
              Last edited {formatDate(current.updatedAt)} · Published via Lexa share link
            </span>
          </div>
        </div>
      </main>
    </>
  );
}

function SharePage() {
  const { token } = Route.useParams();
  const { page } = Route.useSearch();
  const navigate = Route.useNavigate();
  const [tree, setTree] = useState<SharedTree | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Any failure (network error, malformed body) resolves to the dead-link
    // state — a visitor must never see a permanent blank page.
    fetchSharedTree(token)
      .catch(() => null)
      .then((result) => {
        if (!cancelled) {
          setTree(result);
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (!loaded) return <main style={{ minHeight: "100vh" }} />;
  return (
    <SharedWikiPage
      tree={tree}
      token={token}
      pageId={page}
      onSelectPage={(id) => navigate({ search: { page: id } })}
    />
  );
}

export const Route = createFileRoute("/share/$token")({
  validateSearch: (search: Record<string, unknown>): { page?: string } => ({
    page: typeof search.page === "string" && search.page ? search.page : undefined,
  }),
  component: SharePage,
});
