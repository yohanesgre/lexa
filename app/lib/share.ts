import { createIsomorphicFn } from "@tanstack/react-start";
import type { TipTapDoc } from "../../shared/types";

export interface SharedPageNode {
  id: string;
  title: string;
  slug: string;
  content: TipTapDoc | Record<string, never>;
  updatedAt: string;
  children: SharedPageNode[];
}

export interface SharedTree {
  root: SharedPageNode;
}

// Plain-text snippet for the share page's description / og:description.
export function extractSnippet(tree: SharedTree | null): string | null {
  if (!tree?.root.content || typeof tree.root.content !== "object") return null;
  const doc = tree.root.content as TipTapDoc;
  if (!Array.isArray(doc.content)) return null;
  const texts: string[] = [];
  let totalLen = 0;
  const walk = (nodes: unknown[]) => {
    for (const n of nodes) {
      if (totalLen > 160) break;
      if (!n || typeof n !== "object") continue;
      const node = n as { text?: string; content?: unknown[] };
      if (typeof node.text === "string" && node.text.trim()) {
        const t = node.text.trim();
        texts.push(t);
        totalLen += t.length + 1;
      }
      if (Array.isArray(node.content)) walk(node.content);
    }
  };
  walk(doc.content);
  const joined = texts.join(" ").replace(/\s+/g, " ").trim();
  if (!joined) return null;
  return joined.length > 160 ? `${joined.slice(0, 157)}...` : joined;
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
