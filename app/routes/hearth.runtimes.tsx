import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useHearthRole } from "../lib/useHearthRole";
import { useToast } from "../components/ui/Toast";
import { MachinesRuntimesSection } from "../components/settings/SettingsSections";

export const Route = createFileRoute("/hearth/runtimes")({
  ssr:false,
  component: HearthRuntimesRoute,
});

function HearthRuntimesRoute() {
  const { canViewRuntimes, teamsLoading, isSuperadmin } = useHearthRole();
  const toast = useToast();

  useEffect(() => {
    if (!teamsLoading && !canViewRuntimes) {
      toast.push("warning", "You don't have access");
    }
  }, [teamsLoading, canViewRuntimes, toast]);

  if (teamsLoading) return null;
  if (!canViewRuntimes) {
    return <Navigate to="/hearth/runs" replace />;
  }

  return (
    <section className="mt-4">
      <MachinesRuntimesSection showTeamColumn={isSuperadmin} />
    </section>
  );
}
