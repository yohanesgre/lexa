import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/$slug/settings")({
  component: BoardSettingsPage,
});

function BoardSettingsPage() {
  const { slug } = Route.useParams();

  return (
    <div className="page-frame">
      <h1 className="font-display text-2xl font-semibold text-lx-text-primary mb-4">Board Settings</h1>
      <p className="text-sm text-lx-text-secondary">Project: {slug}</p>
    </div>
  );
}
