// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Swimlane } from "../../../shared/types";

const restoreMutate = vi.fn();

vi.mock("../../lib/queries", () => ({
  useUpdateSwimlane: () => ({ mutate: vi.fn() }),
  useDeleteSwimlane: () => ({ mutate: vi.fn() }),
  useCreateColumn: () => ({ mutate: vi.fn() }),
  useArchiveSwimlane: () => ({ mutate: vi.fn() }),
  useRestoreSwimlane: () => ({ mutate: restoreMutate }),
  useMilestones: () => ({ data: [] }),
}));

import { SwimlaneHeader } from "./SwimlaneHeader";

const ARCHIVED: Swimlane = {
  id: "s1",
  projectId: "p1",
  name: "Demo 0",
  description: "",
  position: 0,
  dueAt: null,
  startAt: null,
  archivedAt: "2026-01-01T00:00:00.000Z",
  kind: "sprint",
  milestoneId: null,
};

describe("SwimlaneHeader archived lane", () => {
  it("shows a direct Restore button that restores the lane", async () => {
    const user = userEvent.setup();
    restoreMutate.mockClear();
    render(<SwimlaneHeader slug="demo" lane={ARCHIVED} count={6} />);

    await user.click(screen.getByRole("button", { name: "Restore" }));
    expect(restoreMutate).toHaveBeenCalledWith({ id: "s1" });
  });

  it("does not show the direct Restore button on a live lane", () => {
    render(<SwimlaneHeader slug="demo" lane={{ ...ARCHIVED, archivedAt: null }} count={6} />);
    expect(screen.queryByRole("button", { name: "Restore" })).not.toBeInTheDocument();
  });
});
