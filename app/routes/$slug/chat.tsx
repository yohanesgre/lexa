import { createFileRoute } from "@tanstack/react-router";
import { AssistantChatPage } from "../../components/chat/AssistantChatPage";
import { AssistantUnavailableNotice } from "../../components/assistant/AssistantUnavailableNotice";
import { useAssistantEnabled } from "../../lib/assistant-enabled";
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
  // Capability gate (ADR-0003 §F.3): the chat route is absent on the Docker/Bun
  // flavor — a direct URL renders the capability-disabled notice instead of the
  // surface. Gate while the capabilities read is unresolved so dead controls
  // never flash.
  const { enabled, loading } = useAssistantEnabled();
  if (loading) return null;
  if (!enabled) {
    return (
      <main className="page-frame page-frame-narrow">
        <div className="card-panel">
          <AssistantUnavailableNotice />
        </div>
      </main>
    );
  }
  return <AssistantChatPage slug={slug!} thread={thread} />;
}