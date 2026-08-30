import { createFileRoute } from "@tanstack/react-router";
import { SwimlanesPage } from "../../components/swimlanes/SwimlanesPage";

export const Route = createFileRoute("/$slug/swimlanes")({
  ssr:false,
  component: SwimlanesRoute,
});

function SwimlanesRoute() {
  const { slug } = Route.useParams();
  return <SwimlanesPage slug={slug} />;
}
