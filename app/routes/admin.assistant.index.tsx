import { createFileRoute } from "@tanstack/react-router";
import { AssistantOverviewSection } from "../components/assistant/admin/AssistantOverviewSection";

// /admin/assistant/ — Overview tab (user-menu landing target): KPI summary,
// gateway health (full), recent-runs mini-list, quick links into the tabs.
export const Route = createFileRoute("/admin/assistant/")({
  ssr: false,
  component: AssistantOverviewSection,
});
