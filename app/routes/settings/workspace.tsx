import { createFileRoute } from "@tanstack/react-router";
import { WorkspaceSettings } from "../../components/settings/WorkspaceSettings";

// Superadmin-only. The server enforces on every endpoint; the user menu hides
// the entry for everyone else and direct hits are blocked by the endpoint 403s.
export const Route = createFileRoute("/settings/workspace")({
  component: WorkspaceSettings,
});
