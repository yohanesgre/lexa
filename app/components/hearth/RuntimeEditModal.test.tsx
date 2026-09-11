// @vitest-environment jsdom
// Wireframe settings-runtime-edit.html: the Persona and Model field hints
// name the machine listener as the catalog source.
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Runtime } from "../../../shared/types";

vi.mock("../../lib/queries", () => ({
  useUpdateRuntime: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { RuntimeEditModal } from "./RuntimeEditModal";

const RUNTIME = {
  id: "r1",
  name: "dev-mbp",
  provider: "opencode",
  machineId: "m1",
  agent: "build",
  model: "opencode/deepseek-v4-flash",
  printLogs: true,
  logLevel: "INFO",
  extraArgs: [],
  modelsCatalog: [{ id: "opencode/deepseek-v4-flash", name: "fast", provider: "opencode" }],
  agentsCatalog: [{ id: "build", name: "build" }],
  status: "online",
  lastError: null,
  hostname: "host",
  lastSeen: null,
  createdAt: "2026-01-01T00:00:00Z",
} as unknown as Runtime;

describe("RuntimeEditModal hints", () => {
  it("names the machine listener as the persona and model catalog source", () => {
    render(<RuntimeEditModal runtime={RUNTIME} onClose={vi.fn()} />);
    expect(screen.getByText(/The machine listener reports installed agent personas after setup\. Empty = the CLI default\. Custom remains available\./)).toBeInTheDocument();
    expect(screen.getByText(/Live catalog reported by the machine listener \(opencode models \/ cmd --list-models\), refreshed every ~10 min\./)).toBeInTheDocument();
  });
});
