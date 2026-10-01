// @vitest-environment jsdom
// Workspace → Integrations → GitHub Sync section states
// (wireframes/src/settings-workspace.html). The manual credentials card is
// covered by its own hooks, so it is stubbed here.
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { GithubSettings } from "../../lib/api";

const h = vi.hoisted(() => ({
  settings: { value: undefined as GithubSettings | undefined },
}));

vi.mock("../../lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/queries")>();
  return {
    ...actual,
    useGithubSettings: () => ({ data: h.settings.value, isLoading: false, isError: false }),
    useClearGithubSettings: () => ({ mutate: vi.fn(), isPending: false }),
    useCreateGithubManifest: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

vi.mock("./GithubSyncCredentialsCard", () => ({
  GithubSyncCredentialsCard: () => <div data-testid="manual-credentials" />,
}));

import { GithubSyncSection } from "./SettingsSections";

const NONE: GithubSettings = { appId: "", appSlug: "", privateKeySet: false, webhookSecretSet: false, source: "none" };
const CONNECTED: GithubSettings = { appId: "1234567", appSlug: "lexa-nimbus", privateKeySet: true, webhookSecretSet: true, source: "settings" };

beforeEach(() => {
  h.settings.value = NONE;
});

describe("GithubSyncSection", () => {
  it("shows the idle App card and the manual fallback when not connected", () => {
    render(<GithubSyncSection />);
    expect(screen.getByText(/Connect a GitHub App so Lexa can sync issues both ways/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Connect GitHub App/ })).toBeInTheDocument();
    expect(screen.getByTestId("manual-credentials")).toBeInTheDocument();
  });

  it("shows the connected App card with the read-only id + slug", () => {
    h.settings.value = CONNECTED;
    render(<GithubSyncSection />);
    expect(screen.getByText("connected")).toBeInTheDocument();
    expect(screen.getByDisplayValue("1234567")).toBeInTheDocument();
    expect(screen.getByDisplayValue("lexa-nimbus")).toBeInTheDocument();
  });

  it("renders the return success banner after a callback redirect", () => {
    h.settings.value = CONNECTED;
    render(<GithubSyncSection githubResult={{ status: "connected" }} />);
    expect(screen.getByText("GitHub App connected — secrets stored and webhook configured.")).toBeInTheDocument();
  });

  it("renders the failed card with reason-specific, cause-neutral copy", () => {
    render(<GithubSyncSection githubResult={{ status: "failed", reason: "exchange" }} />);
    expect(screen.getByText("not connected")).toBeInTheDocument();
    expect(screen.getByText(/GitHub couldn't complete the handshake/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry/ })).toBeInTheDocument();
  });
});
