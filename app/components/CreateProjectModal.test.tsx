// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("../lib/queries", () => ({
  useSession: () => ({ data: { user: { role: "superadmin" } } }),
  useTeams: () => ({ data: [], isLoading: false }),
}));

import { CreateProjectModal } from "./CreateProjectModal";

describe("CreateProjectModal", () => {
  it("keeps the entered fields after submitting until the dialog closes", () => {
    const onSubmit = vi.fn();
    render(<CreateProjectModal open pending={false} onClose={vi.fn()} onSubmit={onSubmit} />);

    const name = screen.getByLabelText("Name") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Atlas" } });
    fireEvent.change(screen.getByLabelText("Project team"), { target: { value: "global" } });
    fireEvent.click(screen.getByRole("button", { name: /Create Project/ }));

    expect(onSubmit).toHaveBeenCalledWith({ name: "Atlas", description: undefined, teamId: null });
    expect(name).toHaveValue("Atlas");
  });

  it("disables Create until a team (or Global) is picked, not while the placeholder is selected", () => {
    render(<CreateProjectModal open pending={false} onClose={vi.fn()} onSubmit={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Atlas" } });
    const submit = screen.getByRole("button", { name: /Create Project/ });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Project team"), { target: { value: "global" } });
    expect(submit).toBeEnabled();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<CreateProjectModal open pending={false} onClose={onClose} onSubmit={vi.fn()} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
