// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MilestoneSelector } from "./MilestoneSelector";
import type { Milestone } from "../../../shared/types";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, search, className, children }: any) => (
    <a href={`${to}`} className={className}>{children}</a>
  ),
}));

const MILESTONES: Milestone[] = [
  { id: "m1", projectId: "p1", name: "v1.0 launch", description: "", position: 0, dueAt: null, archivedAt: null, sprintCount: 4, archivedSprintCount: 2 },
  { id: "m2", projectId: "p1", name: "Beta milestone", description: "", position: 1, dueAt: null, archivedAt: null, sprintCount: 2, archivedSprintCount: 0 },
  { id: "m3", projectId: "p1", name: "Prototype", description: "", position: 2, dueAt: null, archivedAt: "2026-07-01T00:00:00.000Z", sprintCount: 1, archivedSprintCount: 1 },
];

describe("MilestoneSelector", () => {
  it("shows the selected milestone with the archived count in the trigger", () => {
    render(<MilestoneSelector milestones={MILESTONES} value="m1" onChange={() => {}} slug="demo" />);
    const trigger = document.querySelector(".ms-selector-trigger")!;
    expect(trigger.textContent).toContain("v1.0 launch");
    expect(trigger.textContent).toContain("2/4 archived");
  });
  it("lists options with counts; archived milestones dimmed; Manage milestones link present", async () => {
    const user = userEvent.setup();
    render(<MilestoneSelector milestones={MILESTONES} value={null} onChange={() => {}} slug="demo" />);
    await user.click(screen.getByRole("button", { name: /No milestone/ }));
    expect(screen.getByText("Beta milestone")).toBeInTheDocument();
    expect(screen.getByText("0/2 sprints archived")).toBeInTheDocument();
    expect(screen.getByText("Prototype")).toBeInTheDocument();
    expect(screen.getByText("(archived)")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Manage milestones/ })).toBeInTheDocument();
    const archivedOption = screen.getByText("Prototype").closest("button")!;
    expect(archivedOption.className).toContain("archived");
  });
});
