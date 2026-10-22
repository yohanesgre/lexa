import { createIsomorphicFn } from "@tanstack/react-start";
import { markdownToText } from "../../shared/markdown";

export interface SharedPageNode {
  id: string;
  title: string;
  slug: string;
  content: string;
  updatedAt: string;
  children: SharedPageNode[];
}

export interface SharedTree {
  root: SharedPageNode;
}

export function extractSnippet(tree: SharedTree | null): string | null {
  if (!tree?.root.content) return null;
  const text = markdownToText(tree.root.content).replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

// Head meta for /share/$token. Runs server-side during SSR (so link unfurlers
// get OG/title/description) and client-side on navigation — same output.
export function shareHeadMeta(tree: SharedTree | null): Array<Record<string, string>> {
  const title = tree?.root.title ?? "Lexa shared page";
  const description = extractSnippet(tree) ?? "Shared via Lexa";
  return [
    { title },
    { name: "description", content: description },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { name: "robots", content: "noindex" },
  ];
}

// Browser branch: the token is a public capability, so a plain same-origin GET
// — no auth header, exactly as before. `credentials` stays default (the share
// surface is session-less).
async function fetchSharedTreeClient(token: string): Promise<SharedTree | null> {
  try {
    const res = await fetch(`/api/share/${encodeURIComponent(token)}`);
    if (!res.ok) return null;
    return (await res.json()) as SharedTree;
  } catch {
    return null;
  }
}

// SSR branch resolves through the share service directly (share.server.ts) —
// never HTTP, which would self-fetch on Workers and need an absolute origin on
// Bun. Same `SharedTree | null` shape either way.
//
// The TanStack Start vite transform swaps the branches at build time. Under
// vitest (no Start plugin) the untransformed stub always resolves to this
// branch; the `typeof window` check routes the jsdom test environment to the
// browser fetch so unit tests exercise the client path.
export const fetchSharedTree = createIsomorphicFn()
  .server(async (token: string): Promise<SharedTree | null> => {
    if (typeof window !== "undefined") return fetchSharedTreeClient(token);
    const { fetchSharedTreeServer } = await import("./share.server");
    return fetchSharedTreeServer(token);
  })
  .client(fetchSharedTreeClient);
