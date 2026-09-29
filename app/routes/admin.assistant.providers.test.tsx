// @vitest-environment jsdom
// /admin/assistant/providers — the Providers & Models tab renders the provider
// registry AND the MCP client registry (same components as the workspace
// Integrations tab).
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: unknown) => ({ ...(opts as object) }),
  Link: ({ to, children }: { to: string; children?: React.ReactNode }) => <a href={to}>{children}</a>,
}));

vi.mock("../lib/queries/assistant-admin", () => ({
  useAssistantProviders: () => ({ data: [], isLoading: false }),
  useTestProvider: () => ({ mutate: vi.fn(), isPending: false }),
  useFetchModels: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateProvider: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateProvider: () => ({ mutate: vi.fn(), isPending: false }),
  useMcpServers: () => ({ data: [], isLoading: false }),
  // Capability unknown from an idle query: the section treats it as OFF.
  useMcpManagedSecrets: () => ({ data: false }),
  useCreateMcpServer: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateMcpServer: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteMcpServer: () => ({ mutate: vi.fn(), isPending: false }),
  useTestMcpServer: () => ({ mutate: vi.fn(), isPending: false }),
  useAssistantJevConfig: () => ({
    data: { config: { id: "default", baseUrl: "https://api.typesafe.ai", model: "jev-latest", enabled: false, hasKey: false, keyMask: null, createdAt: "t", updatedAt: "t" }, secretsEnabled: true },
    isLoading: false,
  }),
  useUpdateAssistantJevConfig: () => ({ mutate: vi.fn(), isPending: false }),
  useTestAssistantJev: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { AssistantProvidersTab } from "./admin.assistant.providers";

describe("admin assistant providers tab", () => {
  it("renders both the provider registry and the MCP client registry", () => {
    render(<AssistantProvidersTab />);
    expect(screen.getByRole("heading", { name: "Assistant Providers" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "MCP Clients" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Jev" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save client" })).toBeInTheDocument();
  });

  it("never shows the removed 'MCP Servers' surface or a stdio option", () => {
    render(<AssistantProvidersTab />);
    expect(screen.queryByText("MCP Servers")).not.toBeInTheDocument();
    const transport = screen.getByLabelText("Transport") as HTMLSelectElement;
    expect(Array.from(transport.options).map((o) => o.value)).toEqual(["http", "sse"]);
  });
});
