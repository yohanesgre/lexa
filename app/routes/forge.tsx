import { createFileRoute } from "@tanstack/react-router";
import { ForgeControlPanel } from "../components/forge/ForgeControlPanel";

// ?task=<id> deep-links the task record slideover (navbar Forge dropdown rows).
export const Route = createFileRoute("/forge")({
  validateSearch: (search: Record<string, unknown>): { task?: string } => ({
    task: typeof search.task === "string" && search.task ? search.task : undefined,
  }),
  component: ForgeControlPanel,
});
