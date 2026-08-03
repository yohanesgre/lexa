import { createFileRoute, useParams } from "@tanstack/react-router";
import { SettingsPage } from "../../components/settings/SettingsPage";

function RouteComponent() {
  const { slug } = useParams({ from: "/$slug/settings" });
  return <SettingsPage slug={slug} />;
}

export const Route = createFileRoute("/$slug/settings")({
  component: RouteComponent,
});
