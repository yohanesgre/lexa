// @vitest-environment jsdom
// /settings/github/callback — the landing GitHub redirects to after App
// creation / authorization (wireframes/src/settings-github-callback.html).
import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

const h = vi.hoisted(() => ({
  session: { value: { user: { role: "superadmin" } } as { user: { role: string } } | null },
  teams: { value: [] as unknown[] },
  navigate: vi.fn(),
  complete: {
    mutate: vi.fn(),
    data: undefined as { appId: string; appSlug: string } | undefined,
    isPending: false,
  },
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({ ...opts, useSearch: () => ({}) }),
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
  Navigate: () => null,
  useNavigate: () => h.navigate,
}));

vi.mock("../../lib/queries", () => ({
  useSession: () => ({ data: h.session.value, isLoading: false }),
  useTeams: () => ({ data: h.teams.value }),
  useCompleteGithubSetup: () => h.complete,
}));

import { GithubCallbackPage } from "./github.callback";

function renderPage(props: { code?: string; state?: string; error?: string }) {
  return render(<GithubCallbackPage {...props} />);
}

beforeEach(() => {
  h.session.value = { user: { role: "superadmin" } };
  h.teams.value = [];
  h.navigate.mockReset();
  h.complete.mutate.mockReset();
  h.complete.data = undefined;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GithubCallbackPage", () => {
  it("shows the completing state while the exchange is in flight", () => {
    h.complete.mutate.mockImplementation(() => {});
    renderPage({ code: "c0de", state: "s1" });
    expect(screen.getByText("Finishing GitHub connection…")).toBeInTheDocument();
    expect(h.complete.mutate).toHaveBeenCalledWith({ code: "c0de", state: "s1" }, expect.anything());
  });

  it("renders the connected confirmation and auto-returns to Settings", () => {
    vi.useFakeTimers();
    h.complete.data = { appId: "1234567", appSlug: "lexa-nimbus" };
    h.complete.mutate.mockImplementation((_input: unknown, opts: { onSuccess?: () => void }) => opts.onSuccess?.());
    renderPage({ code: "c0de", state: "s1" });
    expect(screen.getByText("GitHub connected")).toBeInTheDocument();
    expect(screen.getByText("lexa-nimbus")).toBeInTheDocument();
    expect(screen.getByText("1234567")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1500); });
    expect(h.navigate).toHaveBeenCalledWith({ to: "/settings/workspace", search: { tab: "integrations", github: "connected" } });
  });

  it("shows the cancelled state when consent was declined (no code)", () => {
    h.complete.mutate.mockImplementation((_input: unknown, opts: { onSuccess?: () => void }) => opts.onSuccess?.());
    renderPage({ state: "s1", error: "access_denied" });
    expect(screen.getByText("Connection cancelled — nothing was changed.")).toBeInTheDocument();
  });

  it("shows the invalid state and never calls the server when state is missing", () => {
    renderPage({});
    expect(screen.getByText("This connection link is no longer valid.")).toBeInTheDocument();
    expect(h.complete.mutate).not.toHaveBeenCalled();
  });

  it("shows the invalid state when the consumed state no longer verifies", () => {
    h.complete.mutate.mockImplementation((_input: unknown, opts: { onError?: (e: unknown) => void }) => opts.onError?.({ code: "GITHUB_MANIFEST_STATE_INVALID" }));
    renderPage({ code: "c0de", state: "stale" });
    expect(screen.getByText("This connection link is no longer valid.")).toBeInTheDocument();
  });

  it.each(["GITHUB_MANIFEST_EXCHANGE_FAILED", "GITHUB_MANIFEST_PERMISSIONS_DENIED", "GITHUB_SECRET_WRITE_FAILED"])(
    "renders the fixed cause-neutral failure copy for %s, never the reason-specific variant",
    (code) => {
      h.complete.mutate.mockImplementation((_input: unknown, opts: { onError?: (e: unknown) => void }) => opts.onError?.({ code }));
      renderPage({ code: "c0de", state: "s1" });
      expect(screen.getByText("Lexa couldn't finish connecting — no credentials were saved.")).toBeInTheDocument();
      expect(screen.queryByText(/handshake|required permissions|store the credentials/)).not.toBeInTheDocument();
      expect(screen.getByText("Retry from settings")).toBeInTheDocument();
    }
  );

  it("redirects a non-superadmin to their own settings surface", () => {
    h.session.value = { user: { role: "member" } };
    renderPage({ code: "c0de", state: "s1" });
    expect(screen.queryByText("Finishing GitHub connection…")).not.toBeInTheDocument();
    expect(h.complete.mutate).not.toHaveBeenCalled();
  });
});
