// @vitest-environment jsdom
// /admin/assistant/runs — Recent runs tab: status chips + project filter +
// cursor pagination + error affordance (no `result`).
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>{children}</a>
  ),
}));

const h = vi.hoisted(() => ({ status: null as string | null, projectId: null as string | null }));

vi.mock("../lib/queries/assistant-admin", () => ({
  useAssistantRuns: (params: { status?: string | null; projectId?: string | null }) => {
    h.status = params.status ?? null;
    h.projectId = params.projectId ?? null;
    return {
      data: {
        data: [
          {
            id: "r1", key: "LEX-12", projectId: "p1", documentType: "task", documentId: "t1", documentTitle: "Rate-limit the export endpoint",
            agentId: "a1", skillId: "s1", agentName: "Assistant Agent", skillName: "Requirements", status: "completed", error: null,
            createdAt: "2026-08-27 14:32:07", startedAt: "2026-08-27 14:32:07", finishedAt: "2026-08-27 14:32:49",
          },
          {
            id: "r2", key: "LEX-13", projectId: "p1", documentType: "task", documentId: "t2", documentTitle: "Boss phase transition",
            agentId: "a1", skillId: "s1", agentName: "Assistant Agent", skillName: "Review", status: "failed", error: "PROVIDER_UNREACHABLE — upstream did not respond",
            createdAt: "2026-08-27 12:10:41", startedAt: "2026-08-27 12:10:41", finishedAt: "2026-08-27 12:10:48",
          },
        ],
        nextCursor: "cur-1",
        counts: { queued: 57, running: 3, completed: 1410, failed: 12, cancelled: 0 },
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
  },
}));

vi.mock("../lib/queries", () => ({
  useProjects: () => ({ data: [{ id: "p1", name: "Emberfall", slug: "emberfall" }] }),
}));

import { AssistantRunsTable } from "../components/assistant/admin/AssistantRunsTable";

beforeEach(() => {
  h.status = null;
  h.projectId = null;
});

describe("AssistantRunsTable", () => {
  it("renders the run rows with status chips and counts", () => {
    render(<AssistantRunsTable />);
    expect(screen.getByText("Recent runs")).toBeInTheDocument();
    expect(screen.getByText(/Rate-limit the export endpoint/)).toBeInTheDocument();
    expect(screen.getByText(/Boss phase transition/)).toBeInTheDocument();
    expect(screen.getAllByText("Done").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Failed").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/1,410 done/)).toBeInTheDocument();
  });

  it("passes the status filter through and resets the cursor", async () => {
    const user = userEvent.setup();
    render(<AssistantRunsTable />);
    await user.click(screen.getByRole("button", { name: "Failed" }));
    expect(h.status).toBe("failed");
    expect(screen.getByRole("button", { name: "Failed" })).toHaveAttribute("aria-pressed", "true");
  });

  it("passes the project filter through", async () => {
    const user = userEvent.setup();
    render(<AssistantRunsTable />);
    await user.selectOptions(screen.getByLabelText("Project filter"), "p1");
    expect(h.projectId).toBe("p1");
  });

  it("reveals the error affordance for a failed run", async () => {
    const user = userEvent.setup();
    render(<AssistantRunsTable />);
    expect(screen.queryByText("PROVIDER_UNREACHABLE — upstream did not respond")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show error" }));
    expect(screen.getByText("PROVIDER_UNREACHABLE — upstream did not respond")).toBeInTheDocument();
  });

  it("enables Load more when a next cursor is present", () => {
    render(<AssistantRunsTable />);
    expect(screen.getByRole("button", { name: "Load more" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
  });
});
