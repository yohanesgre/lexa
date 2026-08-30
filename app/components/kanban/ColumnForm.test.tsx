// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ColumnForm } from "./ColumnForm";
import type { Column } from "../../../shared/types";

const COLUMN: Column = {
  id: "c1", projectId: "p1", name: "Done", position: 1, color: "#22c55e",
  wipLimit: 4, requiredFields: ["description"], githubState: "closed", isDone: false,
};

function renderForm(props: Partial<Parameters<typeof ColumnForm>[0]> = {}) {
  const onSubmit = vi.fn();
  const onClose = vi.fn();
  render(
    <ColumnForm slug="demo" column={null} isOpen onSubmit={onSubmit} onClose={onClose} {...props} />
  );
  return { onSubmit, onClose };
}

describe("ColumnForm (create)", () => {
  it("rejects an empty name", async () => {
    const user = userEvent.setup();
    const { onSubmit, onClose } = renderForm();
    await user.click(screen.getByRole("button", { name: /Create Column/ }));
    expect(screen.getByText("Name is required")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
  it("submits name, wipLimit, requiredFields, color, and githubState", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();
    await user.type(screen.getByLabelText("Name"), "In Progress");
    await user.type(screen.getByLabelText(/WIP Limit/), "3");
    await user.click(screen.getByRole("button", { name: /Description/ }));
    await user.selectOptions(screen.getByLabelText("GitHub state mapping"), "open");
    await user.click(screen.getByRole("button", { name: /Create Column/ }));
    expect(onSubmit).toHaveBeenCalledWith({
      name: "In Progress",
      color: null,
      wipLimit: 3,
      requiredFields: ["description"],
      githubState: "open",
      isDone: false,
    });
  });
});
