// @vitest-environment jsdom
// /admin/assistant/bindings — Project bindings tab: one row per project,
// "Not configured" treatment for projects without an assistant_settings row.
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>{children}</a>
  ),
}));

vi.mock("../lib/queries/assistant-admin", () => ({
  useAssistantBindings: () => ({
    data: [
      {
        projectId: "p1", projectName: "Emberfall", projectSlug: "emberfall", providerId: "pr1", providerLabel: "Opencode Go",
        modelId: "m1", modelLabel: "gpt-5.1", fallbackCount: 2, writeToolsCount: 3, memoryCount: 7, hasSearchKey: true,
        reasoningEffort: null, updatedAt: "2026-08-27 12:00:00",
      },
      {
        projectId: "p2", projectName: "Pale Reach", projectSlug: "pale-reach", providerId: null, providerLabel: null,
        modelId: null, modelLabel: null, fallbackCount: 0, writeToolsCount: 0, memoryCount: 0, hasSearchKey: false,
        reasoningEffort: null, updatedAt: null,
      },
    ],
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));

import { AssistantBindingsTable } from "../components/assistant/admin/AssistantBindingsTable";

describe("AssistantBindingsTable", () => {
  it("renders one row per project with the configured/unconfigured summary", () => {
    render(<AssistantBindingsTable />);
    expect(screen.getByText("Project bindings")).toBeInTheDocument();
    expect(screen.getByText(/2 projects · 1 configured · 1 not configured/)).toBeInTheDocument();
    expect(screen.getByText("Emberfall")).toBeInTheDocument();
    expect(screen.getByText("Opencode Go")).toBeInTheDocument();
    expect(screen.getByText("gpt-5.1")).toBeInTheDocument();
    expect(screen.getByText("Configured")).toBeInTheDocument();
  });

  it("renders the Not configured treatment with a Configure CTA", () => {
    render(<AssistantBindingsTable />);
    expect(screen.getByText("Not configured — no provider, model, or fallback chain set")).toBeInTheDocument();
    expect(screen.getByText("Not set")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Configure" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage" })).toBeInTheDocument();
  });
});
