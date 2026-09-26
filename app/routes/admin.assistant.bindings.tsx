import { createFileRoute } from "@tanstack/react-router";
import { AssistantBindingsTable } from "../components/assistant/admin/AssistantBindingsTable";

// /admin/assistant/bindings — Project bindings tab. One row per project,
// read-only overview ("Not configured" treatment included).
export const Route = createFileRoute("/admin/assistant/bindings")({
  ssr: false,
  component: AssistantBindingsTable,
});
