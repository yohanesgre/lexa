import { createFileRoute } from "@tanstack/react-router";
import { AssistantProvidersSection } from "../components/settings/AssistantProvidersSection";
import { AssistantMcpSection } from "../components/settings/AssistantMcpSection";
import { AssistantJevSection } from "../components/settings/AssistantJevSection";

// /admin/assistant/providers — Providers & Models tab. Reuses the workspace
// Integrations sections verbatim (superadmin-gated, same endpoints): the LLM
// provider registry plus the MCP client registry, then the Jev config section.
export function AssistantProvidersTab() {
  return (
    <>
      <AssistantProvidersSection />
      <AssistantMcpSection />
      <AssistantJevSection />
    </>
  );
}

export const Route = createFileRoute("/admin/assistant/providers")({
  ssr: false,
  component: AssistantProvidersTab,
});
