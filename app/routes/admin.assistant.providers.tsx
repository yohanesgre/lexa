import { createFileRoute } from "@tanstack/react-router";
import { AssistantProvidersSection } from "../components/settings/AssistantProvidersSection";
import { AssistantMcpSection } from "../components/settings/AssistantMcpSection";

// /admin/assistant/providers — Providers & Models tab. Reuses the workspace
// Integrations sections verbatim (superadmin-gated, same endpoints): the LLM
// provider registry plus the MCP client registry.
export function AssistantProvidersTab() {
  return (
    <>
      <AssistantProvidersSection />
      <AssistantMcpSection />
    </>
  );
}

export const Route = createFileRoute("/admin/assistant/providers")({
  ssr: false,
  component: AssistantProvidersTab,
});
