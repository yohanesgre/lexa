// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { DeckRailSummary } from "./EffortPicker";
import { ChatComposerArea } from "./AssistantChatShell";
import type { LexaSkill } from "../../../shared/types";

const SKILLS: LexaSkill[] = [
  { id: "s1", name: "Status", description: "", instructions: "", isBuiltin: false, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
  { id: "s2", name: "Review", description: "", instructions: "", isBuiltin: false, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
];

describe("DeckRailSummary — mobile sheet", () => {
  function renderSummary(overrides: Partial<Parameters<typeof DeckRailSummary>[0]> = {}) {
    const onEffortChange = vi.fn();
    const utils = render(
      <DeckRailSummary
        effort=""
        projectEffort="medium"
        onEffortChange={onEffortChange}
        disabled={false}
        {...overrides}
      />
    );
    return { ...utils, onEffortChange };
  }

  it("renders ONE summary chip reading the effort label (no desktop trigger)", () => {
    const { container } = renderSummary();
    expect(container.querySelectorAll(".deck-summary-chip")).toHaveLength(1);
    expect(container.querySelectorAll(".deck-chip")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "default (medium)" })).toBeTruthy();
  });

  it("opens an effort-only sheet and picks a level", () => {
    const { onEffortChange } = renderSummary();
    fireEvent.click(screen.getByRole("button", { name: "default (medium)" }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByRole("listbox", { name: "Skill" })).toBeNull();
    expect(within(dialog).getByRole("listbox", { name: "Thinking effort" })).toBeTruthy();
    expect(within(dialog).getByRole("option", { name: "High" })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("option", { name: "High" }));
    expect(onEffortChange).toHaveBeenCalledWith("high");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("dismisses on Escape", () => {
    renderSummary();
    fireEvent.click(screen.getByRole("button", { name: "default (medium)" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("dismisses on a backdrop click", () => {
    const { container } = renderSummary();
    fireEvent.click(screen.getByRole("button", { name: "default (medium)" }));
    fireEvent.click(container.querySelector(".wiki-sheet-scrim")!);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("returns focus to the summary chip on close", () => {
    renderSummary();
    const chip = screen.getByRole("button", { name: "default (medium)" });
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

  it("places Effort inside .deck-rail, never in .composer-footer, and no skill control", () => {
    const { container } = renderComposerArea();
    const rail = container.querySelector(".deck-rail")!;
    expect(rail).toBeTruthy();
    expect(within(rail as HTMLElement).getByText("Effort")).toBeTruthy();
    expect(rail.contains(screen.getByLabelText("Thinking effort"))).toBe(true);
    expect(rail.textContent).not.toMatch(/skill/i);

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

  it("disables the rail control while streaming", () => {
    renderComposerArea({ streaming: true });
    expect(screen.getByLabelText("Thinking effort")).toBeDisabled();
  });

  it("opens the docked rail menu upward so it never clips at the viewport bottom", () => {
    renderComposerArea({ landing: false });

    fireEvent.click(screen.getByLabelText("Thinking effort"));
    expect((screen.getByRole("listbox", { name: "Thinking effort" }) as HTMLElement).style.bottom).toBe("calc(100% + 4px)");
  });

  it("stretches the landing composer to the dock width", () => {
    const landing = renderComposerArea({ landing: true });
    expect((landing.container.querySelector(".chat-composer") as HTMLElement).style.width).toBe("100%");

    const docked = renderComposerArea({ landing: false });
    expect((docked.container.querySelector(".chat-composer") as HTMLElement).style.width).toBe("");
  });

  it("opens the rail menu downward on the centered landing", () => {
    renderComposerArea({ landing: true });

    fireEvent.click(screen.getByLabelText("Thinking effort"));
    expect((screen.getByRole("listbox", { name: "Thinking effort" }) as HTMLElement).style.bottom).toBe("");
  });
});
