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

export async function fetchSharedTree(token: string): Promise<SharedTree | null> {
  try {
    const path = `/api/share/${encodeURIComponent(token)}`;
    if (typeof window === "undefined") {
      let origin = "http://localhost:3000";
      try {
        const { getRequest } = await import("@tanstack/react-start-server");
        const req = getRequest();
        const envOrigin = typeof process !== "undefined" ? (process.env.LXK_PUBLIC_URL as string | undefined) : undefined;
        origin = req ? new URL(req.url).origin : (envOrigin ?? "http://localhost:3000");
      } catch {
        const envOrigin = typeof process !== "undefined" ? (process.env.LXK_PUBLIC_URL as string | undefined) : undefined;
        if (envOrigin) origin = envOrigin;
      }
      const res = await fetch(`${origin}${path}`);
      if (!res.ok) return null;
      return (await res.json()) as SharedTree;
    }
    const res = await fetch(path);
    if (!res.ok) return null;
    return (await res.json()) as SharedTree;
  } catch {
    return null;
  }
}
