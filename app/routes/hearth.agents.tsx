import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useHearthRole } from "../lib/useHearthRole";
import { useToast } from "../components/ui/Toast";
import { AgentsSettingsSection, SkillsSettingsSection } from "../components/hearth/AgentSkillSettings";

export const Route = createFileRoute("/hearth/agents")({
  component: HearthAgentsRoute,
});

function HearthAgentsRoute() {
  const { canViewAgents, isLoading } = useHearthRole();
  const toast = useToast();

  useEffect(() => {
    if (!isLoading && !canViewAgents) {
      toast.push("warning", "You don't have access");
    }
  }, [isLoading, canViewAgents, toast]);

  if (isLoading) return null;
  if (!canViewAgents) {
    return <Navigate to="/hearth/runs" replace />;
  }

  return (
    <section className="mt-4">
      <AgentsSettingsSection />
      <SkillsSettingsSection />
    </section>
  );
}
