import { createFileRoute } from "@tanstack/react-router";
import { AssistantProvidersSection } from "../components/settings/AssistantProvidersSection";

// /admin/assistant/providers — Providers & Models tab. Reuses the workspace
// Integrations section verbatim (superadmin-gated, same endpoints).
export const Route = createFileRoute("/admin/assistant/providers")({
  ssr: false,
  component: AssistantProvidersSection,
});
