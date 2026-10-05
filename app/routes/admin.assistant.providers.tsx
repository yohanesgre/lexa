import { createFileRoute } from "@tanstack/react-router";
import { AssistantProvidersTab } from "../components/assistant/AssistantProvidersTab";

// /admin/assistant/providers — Providers & Models tab. Reuses the workspace
// Integrations sections verbatim (superadmin-gated, same endpoints): the LLM
// provider registry plus the MCP client registry, then the Jev config section.
export const Route = createFileRoute("/admin/assistant/providers")({
  ssr: false,
  component: AssistantProvidersTab,
});
