import { createFileRoute } from "@tanstack/react-router";
import { HeraldChatPage } from "../../components/chat/HeraldChatPage";
import { getProject } from "../../lib/api";

export const Route = createFileRoute("/$slug/chat")({
  validateSearch: (search: Record<string, unknown>): { thread?: string | undefined } => ({
    thread: typeof search.thread === "string" ? search.thread : undefined,
  }),
  ssr:false,
  loader: async ({ context, params }) => {
    await context.queryClient.prefetchQuery({
      queryKey: ["project", params.slug],
      queryFn: () => getProject(params.slug),
    });
  },
  component: ChatRoute,
});

function ChatRoute() {
  const { slug } = Route.useParams();
  const { thread } = Route.useSearch();
  return <HeraldChatPage slug={slug!} thread={thread} />;
}