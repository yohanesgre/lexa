import { createFileRoute } from "@tanstack/react-router";
import { HearthRunsContent } from "../components/hearth/HearthControlPanel";

export const Route = createFileRoute("/hearth/runs")({
  validateSearch: (search: Record<string, unknown>): { task?: string | undefined } => ({
    task: typeof search.task === "string" && search.task ? search.task : undefined,
  }),
  component: HearthRunsRoute,
});

function HearthRunsRoute() {
  return (
    <section className="mt-4">
      <HearthRunsContent />
    </section>
  );
}
