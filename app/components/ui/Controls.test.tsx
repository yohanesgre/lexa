// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TextArea } from "./TextArea";
import { SelectInput } from "./SelectInput";
import { Checkbox } from "./Checkbox";
import { Toggle } from "./Toggle";

describe("TextArea", () => {
  it("forwards value and onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TextArea value="hello" onChange={onChange} />);
    const textbox = screen.getByRole("textbox");
    expect(textbox).toHaveValue("hello");
    await user.type(textbox, "x");
    expect(onChange).toHaveBeenCalledWith("hellox");
  });
});

describe("SelectInput", () => {
  it("forwards value and onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <SelectInput value="a" onChange={onChange}>
        <option value="a">A</option>
        <option value="b">B</option>
      </SelectInput>
    );
    await user.selectOptions(screen.getByRole("combobox"), "b");
    expect(onChange).toHaveBeenCalledWith("b");
  });
});

describe("Checkbox", () => {
  it("toggles checked state", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Checkbox checked={false} onChange={onChange} label="Description" />);
    await user.click(screen.getByText("Description"));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe("Toggle", () => {
  it("toggles aria-pressed and fires onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} label="Autosave" />);
    const toggle = screen.getByRole("button");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await user.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("renders the is-on visual when checked", () => {
    const onChange = vi.fn();
    const { rerender } = render(<Toggle checked onChange={onChange} />);
    const toggle = screen.getByRole("button");
    expect(toggle.className).toContain("is-on");
    rerender(<Toggle checked={false} onChange={onChange} />);
    expect(toggle.className).not.toContain("is-on");
  });
});
