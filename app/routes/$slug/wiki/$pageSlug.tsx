import { createFileRoute } from "@tanstack/react-router";
import { useWikiPage } from "../../../lib/queries";
import { getWikiPage, listWikiPages } from "../../../lib/api";
import { WikiLayout } from "../../../components/wiki/WikiLayout";
import { WikiPageViewer } from "../../../components/wiki/WikiPageViewer";

export const Route = createFileRoute("/$slug/wiki/$pageSlug")({
  ssr:false,
  loader: async ({ context, params }) => {
    const { slug, pageSlug } = params;
    await Promise.all([
      context.queryClient.prefetchQuery({
        queryKey: ["wiki", slug],
        queryFn: () => listWikiPages(slug).then((r) => r.data),
      }),
      context.queryClient.prefetchQuery({
        queryKey: ["wikiPage", slug, pageSlug],
        queryFn: () => getWikiPage(slug, pageSlug),
      }),
    ]);
  },
  component: WikiPagePage,
});

function WikiPagePage() {
  const { slug, pageSlug } = Route.useParams();
  const { data: page, isLoading, error } = useWikiPage(slug, pageSlug);

  return (
    <WikiLayout slug={slug} activePageSlug={pageSlug}>
      {(pages, _ctx) => {
        if (isLoading) return <div className="text-lx-text-muted">Loading page…</div>;
        if (error) return <div className="text-lx-text-danger">Failed to load page: {(error as Error).message}</div>;
        if (!page) return <div className="text-lx-text-muted">Page not found.</div>;
        return <WikiPageViewer slug={slug} page={page} pages={pages} />;
      }}
    </WikiLayout>
  );
}
