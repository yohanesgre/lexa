// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Field } from "./Field";
import { WarningNotice } from "./NoticeWarning";
import { ConfirmDialog } from "./ConfirmDialog";

describe("Field", () => {
  it("renders an error as .notice.notice-danger, not .field-hint-danger", () => {
    const { container } = render(
      <Field label="Email" error="Invalid email">
        <input />
      </Field>
    );
    const notice = container.querySelector(".notice.notice-danger");
    expect(notice).not.toBeNull();
    expect(notice).toHaveTextContent("Invalid email");
    expect(container.querySelector(".field-hint-danger")).toBeNull();
  });
});

describe("WarningNotice", () => {
  it("uses the .card-panel--warning primitive", () => {
    const { container } = render(<WarningNotice title="No providers yet">Configure one</WarningNotice>);
    expect(container.querySelector(".card-panel.card-panel--warning")).not.toBeNull();
  });
});

describe("ConfirmDialog", () => {
  it("defaults to the danger confirm with btn-sm actions", () => {
    render(<ConfirmDialog title="Delete?" body="Gone" confirmLabel="Delete" onCancel={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveClass("btn", "btn-ghost", "btn-sm");
    expect(screen.getByRole("button", { name: "Delete" })).toHaveClass("btn", "btn-danger-solid", "btn-sm");
  });

  it("supports a default (primary) variant", () => {
    render(
      <ConfirmDialog variant="default" title="Promote?" body="Sure" confirmLabel="Promote" onCancel={vi.fn()} onConfirm={vi.fn()} />
    );
    expect(screen.getByRole("button", { name: "Promote" })).toHaveClass("btn", "btn-primary", "btn-sm");
  });
});
