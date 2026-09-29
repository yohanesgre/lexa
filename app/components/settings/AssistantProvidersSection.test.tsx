// @vitest-environment jsdom
// Workspace → Assistant Providers registry (superadmin-gated).
// Decluttered surface: the three-sentence subtitle and the "No providers yet"
// warning notice are gone. The heading, its two chips, the table, and the
// empty-state row carry the section; the table row already says "No providers
// yet — add one below.", so the notice was a second, wordier copy of it.
//
// Provider API key states (wireframe admin-assistant-providers.html): the key
// is write-only, the chip is the server-provided mask, Clear key → pending
// clear → Save writes `clearKey: true`, and when the server reports
// `secretsEnabled: false` the field renders disabled with a warning naming the
// exact env var — disabled, never hidden.
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({
  providers: [] as unknown[],
  isLoading: false,
  secretsEnabled: true as boolean | undefined,
  created: [] as unknown[],
  updated: [] as unknown[],
}));

vi.mock("../../lib/queries/assistant-admin", () => ({
  useAssistantProviders: () => ({ data: h.providers, isLoading: h.isLoading, secretsEnabled: h.secretsEnabled }),
  useTestProvider: () => ({ mutate: vi.fn(), isPending: false }),
  useFetchModels: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateProvider: () => ({ mutate: (input: unknown, opts?: { onSuccess?: () => void }) => { h.created.push(input); opts?.onSuccess?.(); }, isPending: false }),
  useUpdateProvider: () => ({ mutate: (input: unknown, opts?: { onSuccess?: () => void }) => { h.updated.push(input); opts?.onSuccess?.(); }, isPending: false }),
  useDeleteProvider: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { AssistantProvidersSection } from "./AssistantProvidersSection";
import type { AssistantProvider } from "../../../shared/assistant";

const WITH_KEY: AssistantProvider = { id: "p1", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", hasKey: true, keyMask: "sk-…8f3a", models: [] };

beforeEach(() => {
  h.providers = [];
  h.isLoading = false;
  h.secretsEnabled = true;
  h.created = [];
  h.updated = [];
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

describe("AssistantProvidersSection — no master key", () => {
  beforeEach(() => {
    h.secretsEnabled = false;
    h.providers = [WITH_KEY];
  });

  it("disables the key field, never hides it, and names the exact env var", () => {
    render(<AssistantProvidersSection />);
    expect(screen.getByLabelText("API key")).toBeDisabled();
    expect(screen.getByText(/Key storage is off — this server has no/)).toBeInTheDocument();
    expect(screen.getByText("LXK_SECRETS_MASTER_KEY")).toBeInTheDocument();
    expect(screen.getByText(/Set it and restart to enable/)).toBeInTheDocument();
  });

  it("never hides a stored key — the edit form keeps its chip and Clear trigger", async () => {
    const user = userEvent.setup();
    render(<AssistantProvidersSection />);
    await user.click(screen.getByRole("button", { name: "Edit provider" }));
    expect(screen.getByLabelText("API key")).toBeDisabled();
    expect(screen.getByText(/Saved/, { selector: ".chip" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Clear key/ })).toBeInTheDocument();
  });

  it("lets a key-less provider save without the master key", async () => {
    const user = userEvent.setup();
    render(<AssistantProvidersSection />);
    await user.type(screen.getByLabelText("Label"), "OpenRouter");
    await user.type(screen.getByLabelText("Base URL"), "https://openrouter.ai/api/v1");
    await user.click(screen.getByRole("button", { name: "Save provider" }));
    expect(h.created).toEqual([{ label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: "" }]);
  });

  it("a pending clear on the disabled field names the Save outcome, not a keystroke", async () => {
    const user = userEvent.setup();
    render(<AssistantProvidersSection />);
    await user.click(screen.getByRole("button", { name: "Edit provider" }));
    await user.click(screen.getByRole("button", { name: /Clear key/ }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Clear key/ }));

    const field = screen.getByLabelText("API key");
    expect(field).toBeDisabled();
    expect(field).toHaveAttribute("placeholder", "Save removes the stored key");
    expect(screen.queryByPlaceholderText("Type to cancel the pending clear")).not.toBeInTheDocument();
    expect(screen.getByText("The field stays disabled until the key is set, so the pending clear cannot be cancelled by typing.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep key" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save provider" }));
    expect(h.updated[0]).toMatchObject({ id: "p1", clearKey: true });
  });
});

describe("AssistantProvidersSection — clear key", () => {
  beforeEach(() => {
    h.providers = [WITH_KEY];
  });

  it("Clear key confirms then holds the pending-clear state until Save sends clearKey: true", async () => {
    const user = userEvent.setup();
    render(<AssistantProvidersSection />);
    await user.click(screen.getByRole("button", { name: "Edit provider" }));
    expect(screen.getByText(/Saved/, { selector: ".chip" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Clear key/ }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Clear key/ }));

    // Post-confirm: chip and trigger gone, pending-clear notice held.
    expect(screen.queryByText(/Saved/, { selector: ".chip" })).not.toBeInTheDocument();
    expect(screen.getByText("Key will be removed on Save.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Clear key/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save provider" }));
    expect(h.updated[0]).toMatchObject({ id: "p1", clearKey: true });
    expect(h.updated[0]).not.toHaveProperty("apiKey");
  });

  it("typing into the field cancels the pending clear and keeps the key", async () => {
    const user = userEvent.setup();
    render(<AssistantProvidersSection />);
    await user.click(screen.getByRole("button", { name: "Edit provider" }));
    await user.click(screen.getByRole("button", { name: /Clear key/ }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Clear key/ }));
    await user.type(screen.getByLabelText("API key"), "sk-new");
    expect(screen.queryByText("Key will be removed on Save.")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save provider" }));
    expect(h.updated[0]).toMatchObject({ id: "p1", apiKey: "sk-new" });
    expect(h.updated[0]).not.toHaveProperty("clearKey");
  });
});
