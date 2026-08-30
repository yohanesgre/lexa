import { createFileRoute } from "@tanstack/react-router";
import { MilestonesPage } from "../../components/milestones/MilestonesPage";

export const Route = createFileRoute("/$slug/milestones")({
  validateSearch: (search: Record<string, unknown>): { tab?: "list" | "timeline" | undefined } => ({
    tab: search.tab === "timeline" ? "timeline" : undefined,
  }),
  ssr: false,
  component: MilestonesRoute,
});

function MilestonesRoute() {
  const { slug } = Route.useParams();
  const search = Route.useSearch();
  return <MilestonesPage slug={slug} tab={search.tab ?? "list"} />;
}