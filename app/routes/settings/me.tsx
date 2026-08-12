import { createFileRoute } from "@tanstack/react-router";
import { MeSettings } from "../../components/settings/MeSettings";

// User settings — every signed-in user; own data only.
export const Route = createFileRoute("/settings/me")({
  component: MeSettings,
});
