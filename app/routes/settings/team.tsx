import { createFileRoute } from "@tanstack/react-router";
import { TeamSettings } from "../../components/settings/TeamSettings";

// Team admin: own team only · superadmin: any team (switcher).
export const Route = createFileRoute("/settings/team")({
  ssr:false,
  component: TeamSettings,
});
