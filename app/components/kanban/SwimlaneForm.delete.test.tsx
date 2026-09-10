// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Swimlane } from "../../../shared/types";

vi.mock("../../lib/queries", () => ({
  useMilestones: () => ({ data: [] }),
}));

import { SwimlaneForm } from "./SwimlaneForm";

const LANE: Swimlane = {
  id: "s1",
  projectId: "p1",
  name: "Sprint 7",
  description: "",
  position: 0,
  dueAt: null,
  startAt: null,
  archivedAt: null,
  kind: "sprint",
  milestoneId: null,
};

describe("SwimlaneForm delete", () => {
  it("edit mode calls onDelete with the swimlane instead of closing", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    const onClose = vi.fn();
    const onSubmit = vi.fn();

    render(
      <SwimlaneForm
        slug="demo"
        swimlane={LANE}
        isOpen
        onClose={onClose}
        onDelete={onDelete}
        onSubmit={onSubmit}
      />
    );

    await user.click(screen.getByRole("button", { name: /delete swimlane/i }));

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith(LANE);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("create mode has no delete button", () => {
    render(
      <SwimlaneForm
        slug="demo"
        swimlane={null}
        isOpen
        onClose={vi.fn()}
        onDelete={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    expect(screen.queryByRole("button", { name: /delete swimlane/i })).not.toBeInTheDocument();
  });
});
