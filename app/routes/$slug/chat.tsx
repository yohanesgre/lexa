import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { AssistantUnavailableNotice } from "../../components/assistant/AssistantUnavailableNotice";
import { useAssistantEnabled } from "../../lib/assistant-enabled";
import { getProject } from "../../lib/api";

// The assistant client stack (AI SDK transport, PartySocket, chat state) is a
// leaf: it loads only once the enabled chat surface is actually mounted.
const AssistantChatPage = lazy(() =>
  import("../../components/chat/AssistantChatPage").then((m) => ({ default: m.AssistantChatPage }))
);

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
  // Capability gate (ADR-0003 §F.3): the chat route is absent on the Bun
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
  return (
    <Suspense fallback={null}>
      <AssistantChatPage slug={slug!} thread={thread} />
    </Suspense>
  );
}