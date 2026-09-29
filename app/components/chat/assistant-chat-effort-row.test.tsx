// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { DeckRailSummary, SkillSelect } from "./SkillSelect";
import { ChatComposerArea } from "./AssistantChatShell";
import type { LexaSkill } from "../../../shared/types";

const SKILLS: LexaSkill[] = [
  { id: "s1", name: "Status", description: "", instructions: "", isBuiltin: false, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
  { id: "s2", name: "Review", description: "", instructions: "", isBuiltin: false, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
];

describe("SkillSelect — desktop popover", () => {
  function renderSelect(overrides: Partial<Parameters<typeof SkillSelect>[0]> = {}) {
    const onSkillChange = vi.fn();
    const utils = render(
      <SkillSelect skills={SKILLS} skillId="" onSkillChange={onSkillChange} align="down" disabled={false} {...overrides} />
    );
    return { ...utils, onSkillChange };
  }

  it("opens a listbox with None plus every attached skill and marks the selection", () => {
    const { container } = renderSelect({ skillId: "s1" });
    fireEvent.click(screen.getByRole("button", { name: "Skill — Status" }));

    expect(container.querySelector(".deck-menu")).toBeTruthy();
    const options = container.querySelectorAll('[role="option"]');
    expect(Array.from(options).map((o) => o.textContent)).toEqual(["None", "Status", "Review"]);
    expect(options[0]!.getAttribute("aria-selected")).toBe("false");
    expect(options[1]!.getAttribute("aria-selected")).toBe("true");
  });

  it("calls onSkillChange with the picked id, closes, and returns focus to the trigger", () => {
    const { container, onSkillChange } = renderSelect();
    const trigger = screen.getByRole("button", { name: "Skill — None" });

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: "Review" }));

    expect(onSkillChange).toHaveBeenCalledWith("s2");
    expect(container.querySelector(".deck-menu")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("links the trigger to the popover with aria-controls + a matching id", () => {
    renderSelect();
    const trigger = screen.getByRole("button", { name: "Skill — None" });
    expect(trigger).not.toHaveAttribute("aria-controls");

    fireEvent.click(trigger);
    const menu = screen.getByRole("listbox", { name: "Skill" });
    expect(menu.id).toBeTruthy();
    expect(trigger).toHaveAttribute("aria-controls", menu.id);
  });

  it("is disabled while streaming", () => {
    renderSelect({ disabled: true });
    expect(screen.getByRole("button", { name: "Skill — None" })).toBeDisabled();
  });
});

describe("DeckRailSummary — mobile sheet", () => {
  function renderSummary(overrides: Partial<Parameters<typeof DeckRailSummary>[0]> = {}) {
    const onSkillChange = vi.fn();
    const onEffortChange = vi.fn();
    const utils = render(
      <DeckRailSummary
        skills={SKILLS}
        skillId=""
        effort=""
        projectEffort="medium"
        onSkillChange={onSkillChange}
        onEffortChange={onEffortChange}
        disabled={false}
        {...overrides}
      />
    );
    return { ...utils, onSkillChange, onEffortChange };
  }

  it("renders ONE summary chip reading skill · effort (no desktop trigger)", () => {
    const { container } = renderSummary();
    expect(container.querySelectorAll(".deck-summary-chip")).toHaveLength(1);
    expect(container.querySelectorAll(".deck-chip")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "No skill · default (medium)" })).toBeTruthy();
  });

  it("opens a sheet holding the skill list and the effort levels, and picks from both", () => {
    const { onSkillChange, onEffortChange } = renderSummary();
    fireEvent.click(screen.getByRole("button", { name: "No skill · default (medium)" }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("listbox", { name: "Skill" })).toBeTruthy();
    expect(within(dialog).getByRole("option", { name: "Status" })).toBeTruthy();
    expect(within(dialog).getByRole("listbox", { name: "Thinking effort" })).toBeTruthy();
    expect(within(dialog).getByRole("option", { name: "High" })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("option", { name: "Status" }));
    expect(onSkillChange).toHaveBeenCalledWith("s1");
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "No skill · default (medium)" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("option", { name: "High" }));
    expect(onEffortChange).toHaveBeenCalledWith("high");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("dismisses on Escape", () => {
    renderSummary();
    fireEvent.click(screen.getByRole("button", { name: "No skill · default (medium)" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("dismisses on a backdrop click", () => {
    const { container } = renderSummary();
    fireEvent.click(screen.getByRole("button", { name: "No skill · default (medium)" }));
    fireEvent.click(container.querySelector(".wiki-sheet-scrim")!);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("returns focus to the summary chip on close", () => {
    renderSummary();
    const chip = screen.getByRole("button", { name: "No skill · default (medium)" });
    chip.focus();
    fireEvent.click(chip);
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(chip).toHaveFocus();
  });
});

describe("chat rail placement", () => {
  function renderComposerArea(overrides: Partial<Parameters<typeof ChatComposerArea>[0]> = {}) {
    const utils = render(
      <ChatComposerArea
        skills={SKILLS}
        skillId=""
        onSkillChange={() => {}}
        busy409={false}
        slug="nimbus"
        streaming={false}
        suspendedLock={false}
        suspendCount={0}
        attachDisabled={false}
        isMobileComposer={false}
        effort=""
        projectEffort="medium"
        onEffortChange={() => {}}
        onSend={() => true}
        onAbort={() => {}}
        {...overrides}
      />
    );
    return utils;
  }

  it("places Skill + Effort inside .deck-rail, never in .composer-footer", () => {
    const { container } = renderComposerArea();
    const rail = container.querySelector(".deck-rail")!;
    expect(rail).toBeTruthy();
    expect(within(rail as HTMLElement).getByText("Skill")).toBeTruthy();
    expect(within(rail as HTMLElement).getByText("Effort")).toBeTruthy();
    expect(rail.contains(screen.getByLabelText("Thinking effort"))).toBe(true);

    const footer = container.querySelector(".composer-footer")!;
    expect(footer).toBeTruthy();
    expect(footer.textContent).not.toMatch(/Skill|Effort/);
  });

  it("collapses the rail to the summary chip on mobile", () => {
    const { container } = renderComposerArea({ isMobileComposer: true });
    const rail = container.querySelector(".deck-rail")!;
    expect(rail.querySelectorAll(".deck-summary-chip")).toHaveLength(1);
    expect(within(rail as HTMLElement).queryByText("Effort")).toBeNull();
  });

  it("disables both rail controls while streaming", () => {
    renderComposerArea({ streaming: true });
    expect(screen.getByLabelText("Thinking effort")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Skill — None" })).toBeDisabled();
  });

  it("opens the docked rail menus upward so they never clip at the viewport bottom", () => {
    renderComposerArea({ landing: false });

    fireEvent.click(screen.getByLabelText("Thinking effort"));
    expect((screen.getByRole("listbox", { name: "Thinking effort" }) as HTMLElement).style.bottom).toBe("calc(100% + 4px)");

    fireEvent.click(screen.getByRole("button", { name: "Skill — None" }));
    expect((screen.getByRole("listbox", { name: "Skill" }) as HTMLElement).style.bottom).toBe("calc(100% + 4px)");
  });

  it("opens the rail menus downward on the centered landing", () => {
    renderComposerArea({ landing: true });

    fireEvent.click(screen.getByLabelText("Thinking effort"));
    expect((screen.getByRole("listbox", { name: "Thinking effort" }) as HTMLElement).style.bottom).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Skill — None" }));
    expect((screen.getByRole("listbox", { name: "Skill" })).style.bottom).toBe("");
  });
});
