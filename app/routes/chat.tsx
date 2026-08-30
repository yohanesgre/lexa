import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useProjects } from "../lib/queries";
import { useProjectSelection } from "../lib/project-selection";

// Bare /chat has no slug — without this route it falls into /$slug and
// renders the dashboard for slug "chat" ("Failed to load board: Project
// not found"). Redirect to the selected (or first) project's chat.
export const Route = createFileRoute("/chat")({
  ssr:false,
  component: ChatRedirect,
});

function ChatRedirect() {
  const navigate = useNavigate();
  const { selectedSlug } = useProjectSelection();
  const { data: projects = [] } = useProjects();

  useEffect(() => {
    const slug = selectedSlug ?? projects[0]?.slug;
    if (slug) void navigate({ to: "/$slug/chat", params: { slug }, replace: true });
  }, [selectedSlug, projects, navigate]);

  return null;
}
