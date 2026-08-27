import { createFileRoute } from "@tanstack/react-router";
import { BoardPage } from "../../components/kanban/BoardPage";
import { getBoard } from "../../lib/api";

export const Route = createFileRoute("/$slug/board")({
  // @ts-expect-error — strict: exactOptional indexedAccess
  validateSearch: (search: Record<string, unknown>): { task?: string | undefined; milestone?: string } => ({
    task: typeof search.task === "string" ? search.task : undefined,
    milestone: typeof search.milestone === "string" ? search.milestone : undefined,
  }),
  // The board is the most interactive surface (DnD, TipTap) — keep the DOM
  // client-rendered, but still prefetch + hydrate the board data server-side
  // so the first paint isn't a loading skeleton + client fetch.
  ssr: "data-only",
  loader: async ({ context, params }) => {
    const { slug } = params;
    await context.queryClient.prefetchQuery({
      queryKey: ["board", slug, false],
      queryFn: () => getBoard(slug, false),
    });
  },
  pendingComponent: () => (
    <main className="page-frame">
      <div className="flex items-center justify-between mb-4">
        <div className="skeleton" style={{ width: 160, height: 24 }} />
        <div className="flex items-center gap-3">
          <div className="skeleton" style={{ width: 32, height: 32 }} />
          <div className="skeleton" style={{ width: 120, height: 32 }} />
        </div>
      </div>
      <div className="flex gap-3 overflow-x-auto">
        {[1, 2, 3].map((i) => (
          <div key={i} className="skeleton" style={{ width: 280, height: 400 }} />
        ))}
      </div>
    </main>
  ),
  component: BoardRoute,
});

function BoardRoute() {
  const { slug } = Route.useParams();
  const search = Route.useSearch();
  return <BoardPage slug={slug} search={search} />;
}