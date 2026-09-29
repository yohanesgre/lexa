// @vitest-environment jsdom
// Wireframe admin-assistant-providers.html §Jev: superadmin config row (base
// URL, model, enabled, write-only API key) with the unconfigured / configured /
// no-master-key / test-result states. The key is write-only: Clear key →
// pending clear → Save writes `clearSecret: true`; when `secretsEnabled` is
// false the field renders disabled with a warning naming the exact env var.
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({
  config: {
    id: "default",
    baseUrl: "https://api.typesafe.ai",
    model: "jev-latest",
    enabled: false,
    hasKey: false,
    keyMask: null as string | null,
    createdAt: "t",
    updatedAt: "t",
  },
  secretsEnabled: true as boolean,
  isLoading: false,
  isError: false,
  noData: false,
  updated: [] as unknown[],
  testResult: null as unknown,
  testError: null as unknown,
}));

vi.mock("../../lib/queries/assistant-admin", () => ({
  useAssistantJevConfig: () => {
    const data = h.isLoading || h.noData ? undefined : { config: h.config, secretsEnabled: h.secretsEnabled };
    return { data, isLoading: h.isLoading, isError: h.isError };
  },
  useUpdateAssistantJevConfig: () => ({ mutate: (input: unknown, opts?: { onSuccess?: () => void }) => { h.updated.push(input); opts?.onSuccess?.(); }, isPending: false }),
  useTestAssistantJev: () => ({
    mutate: (_input: unknown, opts?: { onSuccess?: (res: unknown) => void; onError?: (err: unknown) => void }) => {
      if (h.testError) opts?.onError?.(h.testError);
      else opts?.onSuccess?.(h.testResult);
    },
    isPending: false,
  }),
}));

import { AssistantJevSection } from "./AssistantJevSection";

beforeEach(() => {
  h.config = { id: "default", baseUrl: "https://api.typesafe.ai", model: "jev-latest", enabled: false, hasKey: false, keyMask: null, createdAt: "t", updatedAt: "t" };
  h.secretsEnabled = true;
  h.isLoading = false;
  h.isError = false;
  h.noData = false;
  h.updated = [];
  h.testResult = null;
  h.testError = null;
});

describe("AssistantJevSection — structure", () => {
  it("keeps the heading with its scope chips", () => {
    render(<AssistantJevSection />);
    expect(screen.getByRole("heading", { name: "Jev" })).toBeInTheDocument();
    expect(screen.getByText("superadmin-gated")).toBeInTheDocument();
    expect(screen.getByText("Workspace scope")).toBeInTheDocument();
  });

  it("shows the seeded defaults as values", () => {
    render(<AssistantJevSection />);
    expect(screen.getByLabelText("Base URL")).toHaveValue("https://api.typesafe.ai");
    expect(screen.getByLabelText("Model")).toHaveValue("jev-latest");
  });

  it("shows the unconfigured empty panel when Jev is off with no key", () => {
    render(<AssistantJevSection />);
    expect(screen.getByText("Jev is not configured")).toBeInTheDocument();
    expect(screen.getByText(/Add a base URL, model, and API key, then enable Jev/)).toBeInTheDocument();
  });

  it("renders a distinct error affordance on a failed first GET — never an eternal Loading…", () => {
    h.isError = true;
    h.noData = true;
    render(<AssistantJevSection />);
    expect(screen.getByText("Could not load Jev configuration.")).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });

  it("keeps rendering cached content when a background refetch fails (no swap)", () => {
    // isError with data still present is a failed REFETCH, not a first-load
    // failure — the form must survive so unsaved edits are not discarded.
    h.isError = true;
    render(<AssistantJevSection />);
    expect(screen.queryByText("Could not load Jev configuration.")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Base URL")).toHaveValue("https://api.typesafe.ai");
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });
});

describe("AssistantJevSection — save intent", () => {
  it("PATCHes the config fields and sends `secret` only when non-empty", async () => {
    const user = userEvent.setup();
    render(<AssistantJevSection />);
    await user.type(screen.getByLabelText("API key"), "jev_abc123");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(h.updated[0]).toEqual({ baseUrl: "https://api.typesafe.ai", model: "jev-latest", enabled: false, secret: "jev_abc123" });
    expect(h.updated[0]).not.toHaveProperty("clearSecret");
  });

  it("a key-less save omits `secret`", async () => {
    const user = userEvent.setup();
    render(<AssistantJevSection />);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(h.updated[0]).toEqual({ baseUrl: "https://api.typesafe.ai", model: "jev-latest", enabled: false });
  });

  it("toggling Enabled is reflected in the PATCH body", async () => {
    const user = userEvent.setup();
    render(<AssistantJevSection />);
    await user.click(screen.getByRole("button", { name: "Jev disabled" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(h.updated[0]).toMatchObject({ enabled: true });
  });
});

describe("AssistantJevSection — clear key", () => {
  beforeEach(() => {
    h.config = { ...h.config, hasKey: true, keyMask: "jev-…4f2a", enabled: true };
  });

  it("shows the server-provided mask and the Clear key trigger", () => {
    render(<AssistantJevSection />);
    expect(screen.getByText(/Saved/, { selector: ".chip" })).toBeInTheDocument();
    expect(screen.getByText("jev-…4f2a")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Clear key/ })).toBeInTheDocument();
  });

  it("confirm holds the pending-clear state until Save sends clearSecret: true", async () => {
    const user = userEvent.setup();
    render(<AssistantJevSection />);
    await user.click(screen.getByRole("button", { name: /Clear key/ }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Clear key/ }));

    expect(screen.queryByText(/Saved/, { selector: ".chip" })).not.toBeInTheDocument();
    expect(screen.getByText("Key will be removed on Save.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(h.updated[0]).toMatchObject({ clearSecret: true });
    expect(h.updated[0]).not.toHaveProperty("secret");
  });

  it("typing after confirm cancels the pending clear and Save sends `secret`, not `clearSecret`", async () => {
    const user = userEvent.setup();
    render(<AssistantJevSection />);
    await user.click(screen.getByRole("button", { name: /Clear key/ }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Clear key/ }));
    expect(screen.getByText("Key will be removed on Save.")).toBeInTheDocument();

    await user.type(screen.getByLabelText("API key"), "jev_new_key");
    expect(screen.queryByText("Key will be removed on Save.")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(h.updated[0]).toMatchObject({ secret: "jev_new_key" });
    expect(h.updated[0]).not.toHaveProperty("clearSecret");
  });
});

describe("AssistantJevSection — no master key", () => {
  beforeEach(() => {
    h.secretsEnabled = false;
  });

  it("disables the key field, never hides it, and names the exact env var", () => {
    render(<AssistantJevSection />);
    expect(screen.getByLabelText("API key")).toBeDisabled();
    expect(screen.getByText(/Key storage is off — this server has no/)).toBeInTheDocument();
    expect(screen.getByText("LXK_SECRETS_MASTER_KEY")).toBeInTheDocument();
    expect(screen.getByText(/Set it and restart to enable/)).toBeInTheDocument();
  });

  it("still allows a key-less save", async () => {
    const user = userEvent.setup();
    render(<AssistantJevSection />);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(h.updated[0]).not.toHaveProperty("secret");
  });

  it("keeps a stored key's chip and Clear trigger, with Keep key to cancel a pending clear", async () => {
    h.config = { ...h.config, hasKey: true, keyMask: "jev-…4f2a", enabled: true };
    const user = userEvent.setup();
    render(<AssistantJevSection />);
    expect(screen.getByLabelText("API key")).toBeDisabled();
    expect(screen.getByText(/Saved/, { selector: ".chip" })).toBeInTheDocument();
    expect(screen.getByText("jev-…4f2a")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Clear key/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Clear key/ }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Clear key/ }));
    expect(screen.getByText("Key will be removed on Save.")).toBeInTheDocument();

    // Disabled field cannot be typed into: the hint/placeholder must not tell
    // the admin to type, and Keep key is the only cancel route.
    const field = screen.getByLabelText("API key");
    expect(field).toBeDisabled();
    expect(field).toHaveAttribute("placeholder", "Save removes the stored key");
    expect(screen.queryByPlaceholderText("Type to cancel the pending clear")).not.toBeInTheDocument();
    expect(screen.getByText("The field stays disabled until the key is set, so the pending clear cannot be cancelled by typing.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Keep key" }));
    expect(screen.queryByText("Key will be removed on Save.")).not.toBeInTheDocument();
    expect(screen.getByText(/Saved/, { selector: ".chip" })).toBeInTheDocument();
  });
});

describe("AssistantJevSection — test results", () => {
  it("reports latency and model count from a successful test", async () => {
    h.testResult = { ok: true, latencyMs: 318, models: ["jev-small", "jev-latest", "jev-large"] };
    const user = userEvent.setup();
    render(<AssistantJevSection />);
    await user.click(screen.getByRole("button", { name: "Test" }));
    expect(screen.getByText("OK · 318 ms")).toBeInTheDocument();
    expect(screen.getByText("3 models available")).toBeInTheDocument();
  });

  it("renders the fixed JEV_AUTH_FAILED copy from the error code", async () => {
    h.testError = Object.assign(new Error("Jev rejected the API key"), { code: "JEV_AUTH_FAILED" });
    const user = userEvent.setup();
    render(<AssistantJevSection />);
    await user.click(screen.getByRole("button", { name: "Test" }));
    expect(screen.getByText("JEV_AUTH_FAILED")).toBeInTheDocument();
    expect(screen.getByText(/Jev rejected the API key \(401\/403\)/)).toBeInTheDocument();
  });

  it("renders the JEV_UNREACHABLE copy", async () => {
    h.testError = Object.assign(new Error("Jev could not be reached"), { code: "JEV_UNREACHABLE" });
    const user = userEvent.setup();
    render(<AssistantJevSection />);
    await user.click(screen.getByRole("button", { name: "Test" }));
    expect(screen.getByText("JEV_UNREACHABLE")).toBeInTheDocument();
    expect(screen.getByText(/Jev could not be reached \(timeout \/ network\)/)).toBeInTheDocument();
  });

  it("renders the JEV_INVALID_CONFIG copy", async () => {
    h.testError = Object.assign(new Error("bad config"), { code: "JEV_INVALID_CONFIG" });
    const user = userEvent.setup();
    render(<AssistantJevSection />);
    await user.click(screen.getByRole("button", { name: "Test" }));
    expect(screen.getByText("JEV_INVALID_CONFIG")).toBeInTheDocument();
    expect(screen.getByText("The Jev configuration is invalid.")).toBeInTheDocument();
  });

  it("renders the SECRET_KEY_UNAVAILABLE copy", async () => {
    h.testError = Object.assign(new Error("no master key"), { code: "SECRET_KEY_UNAVAILABLE" });
    const user = userEvent.setup();
    render(<AssistantJevSection />);
    await user.click(screen.getByRole("button", { name: "Test" }));
    expect(screen.getByText("SECRET_KEY_UNAVAILABLE")).toBeInTheDocument();
    expect(screen.getByText(/Key storage is off — LXK_SECRETS_MASTER_KEY is not configured\./)).toBeInTheDocument();
  });
});
