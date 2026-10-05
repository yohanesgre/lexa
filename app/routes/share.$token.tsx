import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { SharedWikiPage } from "../components/share/SharedWikiPage";
import { fetchSharedTree, shareHeadMeta, type SharedTree } from "../lib/share";

function SharePage() {
  const { token } = Route.useParams();
  const { page } = Route.useSearch();
  const navigate = Route.useNavigate();
  const loaderData = Route.useLoaderData() as { tree: SharedTree | null };
  const [tree, setTree] = useState<SharedTree | null>(() => loaderData?.tree ?? null);
  const [loaded, setLoaded] = useState(() => loaderData !== undefined);

  useEffect(() => {
    if (loaderData !== undefined) {
      setTree(loaderData.tree);
      setLoaded(true);
    }
  }, [loaderData]);

  useEffect(() => {
    if (loaderData !== undefined) return;
    let cancelled = false;
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
  }, [token, loaderData]);

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
  validateSearch: (search: Record<string, unknown>): { page?: string | undefined } => ({
    page: typeof search.page === "string" && search.page ? search.page : undefined,
  }),
  // Inherits the root's `ssr: true` (no `ssr: false` here), so this route is
  // server-rendered: the loader and `head` below run on the server, giving
  // link unfurlers real OG/title/description and no-JS visitors the rendered
  // page. The token IS the credential (the server enforces it per-request);
  // `fetchSharedTree` resolves via the share service on the server and over
  // the API in the browser (isomorphic).
  loader: async ({ params, context }) => {
    let tree: SharedTree | null = null;
    try {
      tree = await fetchSharedTree(params.token);
    } catch {
      tree = null;
    }
    return { tree };
  },
  head: ({ loaderData }: any) => {
    const ld = loaderData as { tree?: SharedTree | null } | undefined;
    return { meta: shareHeadMeta(ld?.tree ?? null) };
  },
  component: SharePage,
});
