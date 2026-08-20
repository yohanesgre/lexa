import { createFileRoute } from "@tanstack/react-router";
import { TasksPage } from "../../components/tasks/TasksPage";
import { getBoard } from "../../lib/api";

export const Route = createFileRoute("/$slug/tasks")({
  validateSearch: (search: Record<string, unknown>): { task?: string; swimlane?: string } => ({
    task: typeof search.task === "string" ? search.task : undefined,
    swimlane: typeof search.swimlane === "string" ? search.swimlane : undefined,
  }),
  // Interactive list view — same treatment as the board: server-prefetched
  // board data, client-rendered DOM.
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
      <div className="flex flex-col gap-2">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="skeleton" style={{ height: 44 }} />
        ))}
      </div>
    </main>
  ),
  component: TasksRoute,
});

function TasksRoute() {
  const { slug } = Route.useParams();
  const search = Route.useSearch();
  return <TasksPage slug={slug} search={search} />;
}
