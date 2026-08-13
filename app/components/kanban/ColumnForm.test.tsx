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

  it("rejects a WIP limit below 1 with the custom error (noValidate makes the branch live)", async () => {
    // Fixed: the form carries noValidate, so native constraint validation no
    // longer swallows the submit — handleSubmit runs and surfaces the custom
    // "WIP limit must be at least 1" error instead of a silent no-op.
    const user = userEvent.setup();
    const { onSubmit } = renderForm();
    await user.type(screen.getByLabelText("Name"), "X");
    await user.type(screen.getByLabelText(/WIP Limit/), "0");
    await user.click(screen.getByRole("button", { name: /Create Column/ }));
    expect(screen.getByText("WIP limit must be at least 1")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("leaves wipLimit null when the field is empty", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();
    await user.type(screen.getByLabelText("Name"), "X");
    await user.click(screen.getByRole("button", { name: /Create Column/ }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ wipLimit: null }));
  });
});

describe("ColumnForm (edit)", () => {
  it("seeds fields from the column and submits the updated values", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm({ column: COLUMN });
    expect(screen.getByText("Edit Column")).toBeInTheDocument();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Done");
    expect((screen.getByLabelText(/WIP Limit/) as HTMLInputElement).value).toBe("4");
    expect(screen.getByLabelText("GitHub state mapping")).toHaveValue("closed");
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Shipped");
    await user.click(screen.getByRole("button", { name: /Save Changes/ }));
    expect(onSubmit).toHaveBeenCalledWith({
      name: "Shipped",
      color: "#22c55e",
      wipLimit: 4,
      requiredFields: ["description"],
      githubState: "closed",
      isDone: false,
    });
  });

  it("calls onClose for the overlay and the Cancel button", async () => {
    const user = userEvent.setup();
    const { onClose } = renderForm();
    await user.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("renders nothing when closed", () => {
    const { onSubmit } = renderForm({ isOpen: false });
    expect(screen.queryByText("Create Column")).not.toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
