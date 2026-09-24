import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useRuntimeRole } from "../lib/useRuntimeRole";
import { useToast } from "../components/ui/Toast";
import { MachinesRuntimesSection } from "../components/settings/SettingsSections";

export const Route = createFileRoute("/runtimes/daemons")({
  ssr:false,
  component: RuntimeDaemonsRoute,
});

function RuntimeDaemonsRoute() {
  const { canViewRuntimes, teamsLoading, isSuperadmin } = useRuntimeRole();
  const toast = useToast();

  useEffect(() => {
    if (!teamsLoading && !canViewRuntimes) {
      toast.push("warning", "You don't have access");
    }
  }, [teamsLoading, canViewRuntimes, toast]);

  if (teamsLoading) return null;
  if (!canViewRuntimes) {
    return <Navigate to="/runtimes/runs" replace />;
  }

  return (
    <section className="mt-4">
      <MachinesRuntimesSection showTeamColumn={isSuperadmin} />
    </section>
  );
}
