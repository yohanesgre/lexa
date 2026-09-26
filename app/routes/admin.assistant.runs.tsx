import { createFileRoute } from "@tanstack/react-router";
import { AssistantRunsTable } from "../components/assistant/admin/AssistantRunsTable";

// /admin/assistant/runs — Recent runs tab. Read-only: status/project filters,
// keyset cursor pagination, error affordance (no `result` in the list).
export const Route = createFileRoute("/admin/assistant/runs")({
  ssr: false,
  component: AssistantRunsTable,
});
