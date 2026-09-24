import { createFileRoute } from "@tanstack/react-router";
import { RuntimeRunsContent } from "../components/runtimes/RuntimeControlPanel";

export const Route = createFileRoute("/runtimes/runs")({
  validateSearch: (search: Record<string, unknown>): { task?: string | undefined } => ({
    task: typeof search.task === "string" && search.task ? search.task : undefined,
  }),
  ssr:false,
  component: RuntimeRunsRoute,
});

function RuntimeRunsRoute() {
  return (
    <section className="mt-4">
      <RuntimeRunsContent />
    </section>
  );
}
