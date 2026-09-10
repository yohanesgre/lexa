// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("../../lib/queries", () => ({
  useTaskActivity: () => ({
    data: { pages: [] },
    isLoading: false,
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
  }),
  useProjectMembers: () => ({ data: [] }),
  useSession: () => ({ data: null }),
  useUpdateComment: () => ({ mutate: vi.fn() }),
  useDeleteComment: () => ({ mutate: vi.fn() }),
}));

vi.mock("./ActivityTimeline", () => ({ ActivityTimeline: () => null }));
vi.mock("./CommentComposer", () => ({ CommentComposer: () => null }));

import { ActivityTab } from "./ActivityTab";

describe("ActivityTab empty state", () => {
  it("ends the empty-state copy with a period (task-detail.html:500)", () => {
    render(<ActivityTab slug="demo" taskId="t1" isArchived={false} />);
    expect(screen.getByText("No activity yet — be the first to comment.")).toBeInTheDocument();
  });
});
