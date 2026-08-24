// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EngineToggle } from "./HeraldModePicker";

// Toggle gating (forge-popover.html): the member engine toggle renders ONLY
// when the project sets engine_switcher_enabled — hidden means ABSENT from
// the header, not visually muted.
describe("EngineToggle gating", () => {
  it("renders nothing when the project switcher is disabled", () => {
    const onChange = vi.fn();
    const { container } = render(<EngineToggle enabled={false} mode="herald" onChange={onChange} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("radiogroup", { name: "Hearth mode" })).toBeNull();
  });

  it("renders the segmented control when enabled and reports picks", () => {
    const onChange = vi.fn();
    render(<EngineToggle enabled mode="herald" onChange={onChange} />);
    const group = screen.getByRole("radiogroup", { name: "Hearth mode" });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /herald/i })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: /blacksmith/i }));
    expect(onChange).toHaveBeenCalledWith("blacksmith");
  });
});
