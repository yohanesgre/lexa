// @vitest-environment jsdom
// Workspace → Assistant Providers registry (superadmin-gated).
// Decluttered surface: the three-sentence subtitle and the "No providers yet"
// warning notice are gone. The heading, its two chips, the table, and the
// empty-state row carry the section; the table row already says "No providers
// yet — add one below.", so the notice was a second, wordier copy of it.
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  providers: [] as unknown[],
  isLoading: false,
}));

vi.mock("../../lib/queries/assistant-admin", () => ({
  useAssistantProviders: () => ({ data: h.providers, isLoading: h.isLoading }),
  useTestProvider: () => ({ mutate: vi.fn(), isPending: false }),
  useFetchModels: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateProvider: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateProvider: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteProvider: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { AssistantProvidersSection } from "./AssistantProvidersSection";

beforeEach(() => {
  h.providers = [];
  h.isLoading = false;
});

describe("AssistantProvidersSection — structure", () => {
  it("keeps the heading with its scope chips", () => {
    render(<AssistantProvidersSection />);
    expect(screen.getByRole("heading", { name: "Assistant Providers" })).toBeInTheDocument();
    expect(screen.getByText("superadmin-gated")).toBeInTheDocument();
    expect(screen.getByText("Workspace scope")).toBeInTheDocument();
  });

  it("keeps the table and the empty-state row", () => {
    render(<AssistantProvidersSection />);
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Label" })).toBeInTheDocument();
    expect(screen.getByText("No providers yet — add one below.")).toBeInTheDocument();
  });

  it("shows a loading state instead of the table while fetching", () => {
    h.isLoading = true;
    render(<AssistantProvidersSection />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});

describe("AssistantProvidersSection — decluttered copy", () => {
  it("carries no section subtitle", () => {
    render(<AssistantProvidersSection />);
    expect(screen.queryByText(/Central registry of LLM providers/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Projects pick a primary provider/)).not.toBeInTheDocument();
    expect(screen.queryByText(/masked on read, never serialized/)).not.toBeInTheDocument();
  });

  it("does not repeat the empty state in a warning notice", () => {
    const { container } = render(<AssistantProvidersSection />);
    // The notice is gone; the table row keeps the message.
    expect(screen.queryByText("No providers yet")).not.toBeInTheDocument();
    expect(screen.queryByText(/Add a provider above to enable Assistant/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Projects cannot select a model until at least one provider has enabled models/)).not.toBeInTheDocument();
    expect(container.querySelectorAll(".card-panel--warning")).toHaveLength(0);
  });
});
