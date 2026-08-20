import { createFileRoute, Navigate } from "@tanstack/react-router";
import { listWikiPages } from "../../../lib/api";
import { WikiLayout } from "../../../components/wiki/WikiLayout";
import { WikiEmptyState } from "../../../components/wiki/WikiEmptyState";
import { firstRootPage } from "../../../lib/wiki";
import type { WikiPageMeta } from "../../../../shared/types";

export const Route = createFileRoute("/$slug/wiki/")({
  loader: async ({ context, params }) => {
    const { slug } = params;
    await context.queryClient.prefetchQuery({
      queryKey: ["wiki", slug],
      queryFn: () => listWikiPages(slug).then((r) => r.data),
    });
  },
  component: WikiIndexPage,
});

function WikiIndexPage() {
  const { slug } = Route.useParams();
  return (
    <WikiLayout slug={slug}>
      {(pages, { openNewPage }) => {
        if (pages.length === 0) {
          return (
            <div className="wiki-content">
              <WikiEmptyState onCreate={openNewPage} />
            </div>
          );
        }
        const first = firstRootPage(pages);
        if (first) {
          return (
            <Navigate
              to="/$slug/wiki/$pageSlug"
              params={{ slug, pageSlug: first.slug }}
              replace
            />
          );
        }
        return (
          <div className="wiki-content">
            <div className="flex items-center justify-center h-full text-lx-text-muted">
              <div className="text-center">
                <p className="text-sm">Select a page from the sidebar to start reading.</p>
              </div>
            </div>
          </div>
        );
      }}
    </WikiLayout>
  );
}
