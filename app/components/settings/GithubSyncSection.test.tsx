// @vitest-environment jsdom
// Workspace → Integrations → GitHub Sync section states
// (wireframes/src/settings-workspace.html). The manual credentials card is
// covered by its own hooks, so it is stubbed here.
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { GithubSettings, GithubInstallations } from "../../lib/api";

const h = vi.hoisted(() => ({
  settings: { value: undefined as GithubSettings | undefined },
  installations: { value: { status: "installed", accounts: ["acme-corp"] } as GithubInstallations },
  loading: { value: false },
}));

vi.mock("../../lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/queries")>();
  return {
    ...actual,
    useGithubSettings: () => ({ data: h.settings.value, isLoading: h.loading.value, isError: false }),
    useGithubInstallations: () => ({ data: h.installations.value }),
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

function manualDetails(): HTMLDetailsElement {
  return screen.getByText("Advanced: manual credentials").closest("details") as HTMLDetailsElement;
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  h.settings.value = NONE;
  h.installations.value = { status: "installed", accounts: ["acme-corp"] };
  h.loading.value = false;
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

  it("shows the installed accounts + badge when the probe reports an installation", () => {
    h.settings.value = CONNECTED;
    h.installations.value = { status: "installed", accounts: ["acme-corp", "nimbus-labs"] };
    render(<GithubSyncSection />);
    expect(screen.getByText("acme-corp")).toBeInTheDocument();
    expect(screen.getByText("nimbus-labs")).toBeInTheDocument();
    expect(screen.getByText("installed")).toBeInTheDocument();
  });

  it("shows the Install App CTA linking to the App's install page when not installed", () => {
    h.settings.value = CONNECTED;
    h.installations.value = { status: "not_installed", accounts: [] };
    render(<GithubSyncSection />);
    expect(screen.getByText("The App isn't installed on any account yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Install App" })).toHaveAttribute("href", "https://github.com/apps/lexa-nimbus/installations/new");
  });

  it("shows the cause-neutral unknown degrade when the probe can't answer", () => {
    h.settings.value = CONNECTED;
    h.installations.value = { status: "unknown", accounts: [] };
    render(<GithubSyncSection />);
    expect(screen.getByText("Couldn't check whether the App is installed right now.")).toBeInTheDocument();
  });

  it("keeps the manual disclosure collapsed once the App is configured", () => {
    h.settings.value = CONNECTED;
    render(<GithubSyncSection />);
    expect(manualDetails().open).toBe(false);
  });

  it("expands the manual disclosure when the App is not configured", () => {
    render(<GithubSyncSection />);
    expect(manualDetails().open).toBe(true);
  });

  it("auto-expands the manual disclosure when the connect flow fails", () => {
    h.settings.value = CONNECTED;
    render(<GithubSyncSection githubResult={{ status: "failed", reason: "exchange" }} />);
    expect(manualDetails().open).toBe(true);
  });

  it("auto-expands the manual disclosure once a first uncached load resolves unconfigured", () => {
    h.loading.value = true;
    const { rerender } = render(<GithubSyncSection />);
    expect(screen.queryByText("Advanced: manual credentials")).not.toBeInTheDocument();
    h.loading.value = false;
    rerender(<GithubSyncSection />);
    expect(manualDetails().open).toBe(true);
  });

  it("force-opens the manual disclosure when a ?github=failed callback resolves a configured App", () => {
    h.loading.value = true;
    h.settings.value = CONNECTED;
    const result = { status: "failed", reason: "exchange" } as const;
    const { rerender } = render(<GithubSyncSection githubResult={result} />);
    h.loading.value = false;
    rerender(<GithubSyncSection githubResult={result} />);
    expect(manualDetails().open).toBe(true);
  });

  it("stays collapsed when a configured App resolves from a first uncached load", () => {
    h.loading.value = true;
    h.settings.value = CONNECTED;
    const { rerender } = render(<GithubSyncSection />);
    h.loading.value = false;
    rerender(<GithubSyncSection />);
    expect(manualDetails().open).toBe(false);
  });

  it("keeps the failed card's manual escape hatch and expands the disclosure on click", () => {
    h.settings.value = CONNECTED;
    render(<GithubSyncSection githubResult={{ status: "failed", reason: "unknown" }} />);
    const details = manualDetails();
    details.open = false;
    fireEvent.click(screen.getByRole("button", { name: "Use manual credentials" }));
    expect(details.open).toBe(true);
  });
});
