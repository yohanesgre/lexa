import { createFileRoute } from "@tanstack/react-router";
import { TaskDetailPage, TaskDetailPageSkeleton } from "../../components/tasks/TaskDetailPage";
import { getBoard, getTask } from "../../lib/api";

export const Route = createFileRoute("/$slug/tasks_/$taskId")({
  validateSearch: (search: Record<string, unknown>): { from?: "board" | "tasks" | undefined } => ({
    from: search.from === "board" || search.from === "tasks" ? search.from : undefined,
  }),
  ssr: false,
  loader: async ({ context, params }) => {
    const { slug, taskId } = params;
    await Promise.all([
      context.queryClient.prefetchQuery({
        queryKey: ["board", slug, false],
        queryFn: () => getBoard(slug, false),
      }),
      context.queryClient.prefetchQuery({
        queryKey: ["tasks", slug, taskId],
        queryFn: () => getTask(slug, taskId),
      }),
    ]);
  },
  pendingComponent: TaskDetailPageSkeleton,
  component: TaskDetailPageRoute,
});

function TaskDetailPageRoute() {
  const { slug, taskId } = Route.useParams();
  const { from } = Route.useSearch();
  return <TaskDetailPage slug={slug} taskId={taskId} from={from} />;
}
