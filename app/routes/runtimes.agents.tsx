import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useRuntimeRole } from "../lib/useRuntimeRole";
import { useToast } from "../components/ui/Toast";
import { AgentsSettingsSection, SkillsSettingsSection } from "../components/runtimes/AgentSkillSettings";

export const Route = createFileRoute("/runtimes/agents")({
  ssr:false,
  component: AgentsRoute,
});

function AgentsRoute() {
  const { canViewAgents, isLoading } = useRuntimeRole();
  const toast = useToast();

  useEffect(() => {
    if (!isLoading && !canViewAgents) {
      toast.push("warning", "You don't have access");
    }
  }, [isLoading, canViewAgents, toast]);

  if (isLoading) return null;
  if (!canViewAgents) {
    return <Navigate to="/runtimes/runs" replace />;
  }

  return (
    <section className="mt-4">
      <AgentsSettingsSection />
      <SkillsSettingsSection />
    </section>
  );
}
