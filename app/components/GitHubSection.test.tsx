// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { GithubIssue } from "../../shared/types";
import { GitHubSection } from "./GitHubSection";
import { ToastProvider } from "./ui/Toast";

const fetchMock = vi.fn();
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let queryClient: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}

const ISSUE: GithubIssue = {
  issueId: "ghi1",
  issueNumber: 107,
  repo: "emberfall-godot",
  title: "Crash on large board load",
  syncedState: "open",
  url: "https://github.com/emberfall-godot/issues/107",
  outOfSync: false,
  pushFailed: false,
};

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve(json({ data: [] })));
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  queryClient.clear();
});

function renderSection(githubs: GithubIssue[]) {
  return render(
    <GitHubSection
      taskId="t1"
      slug="demo"
      githubs={githubs}
      columnGithubState="open"
      onLink={async () => null}
      onUnlink={async () => {}}
    />,
    { wrapper }
  );
}

describe("GitHubSection linked issue rows", () => {
  it("renders repo #number · title when the title is present", () => {
    renderSection([ISSUE]);
    expect(screen.getByText("emberfall-godot #107")).toBeInTheDocument();
    expect(screen.getByText("· Crash on large board load")).toBeInTheDocument();
  });

  it("renders only repo #number when the title is null", () => {
    renderSection([{ ...ISSUE, title: null }]);
    expect(screen.getByText("emberfall-godot #107")).toBeInTheDocument();
    expect(screen.queryByText(/·/)).not.toBeInTheDocument();
  });
});
