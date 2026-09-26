import { createFileRoute } from "@tanstack/react-router";
import { AgentsSettingsSection, SkillsSettingsSection } from "../components/settings/assistant/AgentSkillSettings";

// /admin/assistant/agents — Agents & Skills tab. Reuses the workspace sections
// verbatim (superadmin-gated, same endpoints).
function AgentsSkillsRoute() {
  return (
    <>
      <AgentsSettingsSection />
      <SkillsSettingsSection />
    </>
  );
}

export const Route = createFileRoute("/admin/assistant/agents")({
  ssr: false,
  component: AgentsSkillsRoute,
});
