import { createFileRoute } from "@tanstack/react-router";
import { useWikiPage } from "../../../lib/queries";
import { WikiLayout } from "../../../components/wiki/WikiLayout";
import { WikiPageViewer } from "../../../components/wiki/WikiPageViewer";

export const Route = createFileRoute("/$slug/wiki/$pageSlug")({
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
