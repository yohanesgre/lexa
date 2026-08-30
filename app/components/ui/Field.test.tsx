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
});
