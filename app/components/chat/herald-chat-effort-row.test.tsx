// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { ChatSkillsPanel } from "./HeraldChatTurns";
import { HeraldChatComposer } from "./HeraldChatComposer";
import type { LexaSkill } from "../../../shared/types";

const SKILLS: LexaSkill[] = [
  { id: "s1", name: "Status", description: "", instructions: "", isBuiltin: false, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
  { id: "s2", name: "Review", description: "", instructions: "", isBuiltin: false, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
];

function renderPanel(overrides: Partial<Parameters<typeof ChatSkillsPanel>[0]> = {}) {
  const onEffortChange = vi.fn();
  const view = render(
    <ChatSkillsPanel
      open
      skillName="Status"
      skills={SKILLS}
      skillId="s1"
      effort=""
      projectEffort="medium"
      onEffortChange={onEffortChange}
      disabled={false}
      isMobileComposer={false}
      onToggle={() => {}}
      onSkillChange={() => {}}
      {...overrides}
    />
  );
  return { ...view, onEffortChange };
}

describe("chat effort selector placement", () => {
  it("renders the Effort control inside the Skill picker row", () => {
    const { container } = renderPanel();
    const row = container.querySelector(".skills-panel-body .flex.items-center")!;
    expect(within(row as HTMLElement).getByText("Skill")).toBeTruthy();
    expect(within(row as HTMLElement).getByLabelText("Thinking effort")).toBeTruthy();
  });

  it("reflects the value and calls onEffortChange from the row", () => {
    const { onEffortChange } = renderPanel({ effort: "high" });
    const trigger = screen.getByLabelText("Thinking effort");
    expect(trigger.textContent).toContain("high");

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: /Minimal/ }));
    expect(onEffortChange).toHaveBeenCalledWith("minimal");
  });

  it("disables the Effort control while streaming", () => {
    renderPanel({ disabled: true });
    expect(screen.getByLabelText("Thinking effort")).toBeDisabled();
  });

  it("keeps the Effort control out of the composer footer", () => {
    const { container } = render(
      <HeraldChatComposer
        slug="nimbus"
        streaming={false}
        busy409={false}
        suspendedLock={false}
        suspendTally=""
        attachDisabled={false}
        onSend={() => {}}
        onAbort={() => {}}
      />
    );
    expect(container.querySelector(".composer-footer")).toBeTruthy();
    expect(container.querySelector(".composer-footer")!.textContent).not.toContain("Effort");
    expect(container.querySelector(".composer-footer")!.textContent).not.toContain("default");
  });
});
