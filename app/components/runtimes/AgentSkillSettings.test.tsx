// @vitest-environment jsdom
// Wireframe settings-agents-skills.html: builtin skill rows show a DISABLED
// trash (never deletable); custom rows stay enabled.
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { LexaSkill } from "../../../shared/types";

const h = vi.hoisted(() => ({ skills: [] as unknown[], agents: [] as unknown[] }));

vi.mock("../../lib/queries", () => ({
  useAgents: () => ({ data: h.agents, isLoading: false, isError: false }),
  useSkills: () => ({ data: h.skills, isLoading: false, isError: false }),
}));

import { SkillsSettingsSection } from "./AgentSkillSettings";

function skill(overrides: Partial<LexaSkill>): LexaSkill {
  return {
    id: "s1",
    name: "Requirements",
    description: "Write clear requirements.",
    instructions: "",
    isBuiltin: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("SkillsSettingsSection builtin trash", () => {
  it("renders a disabled delete button for builtins and an enabled one for custom skills", () => {
    h.skills = [
      skill({ id: "s1", name: "Requirements", isBuiltin: true }),
      skill({ id: "s2", name: "My skill", isBuiltin: false }),
    ];
    render(<SkillsSettingsSection />);

    expect(screen.getByRole("button", { name: "Delete Requirements" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete My skill" })).toBeEnabled();
  });
});
