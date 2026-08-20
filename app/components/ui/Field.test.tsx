// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Field } from "./Field";
import { TextInput } from "./TextInput";

describe("Field", () => {
  it("renders label, hint, and control", () => {
    render(
      <Field label="Name" hint="Shown on the dashboard.">
        <TextInput value="" onChange={() => {}} />
      </Field>
    );
    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(screen.getByText("Shown on the dashboard.")).toBeInTheDocument();
  });

  it("renders the error message and marks the control invalid", () => {
    render(
      <Field label="Name" error="Required">
        <TextInput value="" onChange={() => {}} />
      </Field>
    );
    expect(screen.getByText("Required")).toBeInTheDocument();
    const input = screen.getByRole("textbox");
    expect(input).toHaveAttribute("aria-invalid", "true");
  });

  it("wires label htmlFor to the control id", () => {
    render(
      <Field label="Name" htmlFor="my-name">
        <TextInput id="my-name" value="" onChange={() => {}} />
      </Field>
    );
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
  });

  it("treats error={false} as valid with no danger hint", () => {
    const { container } = render(
      <Field label="Name" error={false}>
        <TextInput value="" onChange={() => {}} />
      </Field>
    );
    const input = screen.getByRole("textbox");
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(container.querySelector(".field-hint-danger")).not.toBeInTheDocument();
  });

  it("omits aria-describedby without a hint or error", () => {
    render(
      <Field label="Name">
        <TextInput value="" onChange={() => {}} />
      </Field>
    );
    expect(screen.getByRole("textbox")).not.toHaveAttribute("aria-describedby");
  });

  it("points aria-describedby at the hint element when a hint is present", () => {
    render(
      <Field label="Name" hint="Shown on the dashboard.">
        <TextInput value="" onChange={() => {}} />
      </Field>
    );
    const input = screen.getByRole("textbox");
    const hint = screen.getByText("Shown on the dashboard.");
    expect(input).toHaveAttribute("aria-describedby", hint.id);
  });
});
