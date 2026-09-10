// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { Board, Milestone } from "../../../shared/types";

vi.mock("../../lib/queries", () => ({
  useBoard: () => ({ data: undefined }),
  useUpdateSwimlane: () => ({ mutate: vi.fn() }),
  useUpdateMilestone: () => ({ mutate: vi.fn() }),
  useDeleteSwimlane: () => ({ mutate: vi.fn() }),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));

import { TimelineTab } from "./TimelineTab";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
beforeAll(() => vi.stubGlobal("ResizeObserver", ResizeObserverStub));
afterAll(() => vi.unstubAllGlobals());

const MILESTONE: Milestone = {
  id: "m1",
  projectId: "p1",
  name: "v1.0 launch",
  description: "",
  position: 0,
  dueAt: "2026-06-01",
  archivedAt: null,
  sprintCount: 1,
  archivedSprintCount: 0,
};

function makeBoard(): Board {
  return {
    project: { id: "p1", slug: "demo", name: "Demo", key: "DEMO", description: "", repos: [], createdAt: "t", updatedAt: "t" },
    columns: [],
    swimlanes: [
      { id: "s1", projectId: "p1", name: "Sprint 7", description: "", position: 0, dueAt: null, startAt: null, archivedAt: null, kind: "sprint", milestoneId: "m1" },
      { id: "s9", projectId: "p1", name: "Backlog", description: "", position: 1, dueAt: null, startAt: null, archivedAt: null, kind: "backlog", milestoneId: null },
      { id: "s10", projectId: "p1", name: "Old lane", description: "", position: 2, dueAt: null, startAt: null, archivedAt: "2026-01-01", kind: "sprint", milestoneId: null },
    ],
    milestones: [MILESTONE],
    fieldConfig: { priorities: [], types: [] },
    links: [],
    tasks: [],
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("TimelineTab backlog caption", () => {
  it("renders the Backlog caption row for a backlog lane", () => {
    const { container } = render(
      <TimelineTab slug="demo" board={makeBoard()} milestones={[MILESTONE]} />,
      { wrapper }
    );

    expect(screen.getByText("system lane")).toBeInTheDocument();
    const captions = container.querySelectorAll(".tl-label.caption");
    expect(captions).toHaveLength(1);
    expect(captions[0]).toHaveTextContent("Backlog");
  });
});
