import { createFileRoute } from "@tanstack/react-router";
import { ForgeControlPanel } from "../components/forge/ForgeControlPanel";

export const Route = createFileRoute("/forge")({
  component: ForgeControlPanel,
});
