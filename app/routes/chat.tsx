import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { AssistantUnavailableNotice } from "../components/assistant/AssistantUnavailableNotice";
import { useAssistantEnabled } from "../lib/assistant-enabled";
import { useProjects } from "../lib/queries";
import { useProjectSelection } from "../lib/project-selection";

// Bare /chat has no slug — without this route it falls into /$slug and
// renders the dashboard for slug "chat" ("Failed to load board: Project
// not found"). Redirect to the selected (or first) project's chat. On the
// capability-disabled flavor there is no chat to reach, so the notice renders
// in place of the redirect.
export const Route = createFileRoute("/chat")({
  ssr:false,
  component: ChatRedirect,
});

function ChatRedirect() {
  const navigate = useNavigate();
  const { selectedSlug } = useProjectSelection();
  const { data: projects = [] } = useProjects();
  const { enabled, loading } = useAssistantEnabled();

  useEffect(() => {
    if (!enabled) return;
    const slug = selectedSlug ?? projects[0]?.slug;
    if (slug) void navigate({ to: "/$slug/chat", params: { slug }, replace: true });
  }, [selectedSlug, projects, navigate, enabled]);

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
  return null;
}
