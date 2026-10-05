import { createFileRoute } from "@tanstack/react-router";
import { AssistantShell } from "../components/assistant/AssistantShell";

// /admin/assistant — the superadmin shell: fixed header + tab bar + <Outlet/>.
// The tabs are first-class child routes; Overview is the user-menu landing
// target. /admin/assistant/usage stays canonical (no redirect).
export const Route = createFileRoute("/admin/assistant")({
  ssr: false,
  component: AssistantShell,
});
