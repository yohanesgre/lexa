// @vitest-environment jsdom
// SkillPicker overflow menu semantics + keyboard: Arrow/Home/End move focus,
// Escape closes the menu without bubbling to the popover's document handler,
// and focus returns to the ⋯ trigger.
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SkillPicker } from "./SkillPicker";
import type { LexaSkill } from "../../../../shared/types";

const skills: LexaSkill[] = Array.from({ length: 8 }, (_, i) => ({
  id: `s${i}`,
  name: `Skill ${i}`,
  description: "",
  instructions: "",
  isBuiltin: true,
  createdAt: "t",
  updatedAt: "t",
}));

describe("SkillPicker overflow menu", () => {
  it("navigates with Arrow/Home/End and closes on Escape without leaking to document", () => {
    render(<SkillPicker skills={skills} skillId="s0" onSkillChange={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "More skills" });
    fireEvent.click(trigger);

    const menu = screen.getByRole("menu");
    const items = screen.getAllByRole("menuitem");
    expect(items).toHaveLength(2);
    expect(document.activeElement).toBe(items[0]);

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: "Home" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[0]);

    // Outside mousedown closes the menu.
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    // Escape must close the menu (capture) and not reach the popover's
    // document-level (bubble) keydown dismiss; focus returns to the trigger.
    fireEvent.click(trigger);
    const docBubbleListener = vi.fn();
    document.addEventListener("keydown", docBubbleListener);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    document.removeEventListener("keydown", docBubbleListener);
    expect(docBubbleListener).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it("selects from the menu and closes it", () => {
    const onSkillChange = vi.fn();
    render(<SkillPicker skills={skills} skillId="s0" onSkillChange={onSkillChange} />);
    fireEvent.click(screen.getByRole("button", { name: "More skills" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Skill 6" }));
    expect(onSkillChange).toHaveBeenCalledWith("s6");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
