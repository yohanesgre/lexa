import { createFileRoute } from "@tanstack/react-router";
import { HearthControlPanel } from "../components/hearth/HearthControlPanel";

// ?task=<id> deep-links the task record slideover (navbar Hearth dropdown rows).
export const Route = createFileRoute("/hearth")({
  validateSearch: (search: Record<string, unknown>): { task?: string } => ({
    task: typeof search.task === "string" && search.task ? search.task : undefined,
  }),
  component: HearthControlPanel,
});
