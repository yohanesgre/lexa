import { AssistantProvidersSection } from "../settings/AssistantProvidersSection";
import { AssistantMcpSection } from "../settings/AssistantMcpSection";
import { AssistantJevSection } from "../settings/AssistantJevSection";

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
