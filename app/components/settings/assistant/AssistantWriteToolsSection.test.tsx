// @vitest-environment jsdom
// Wireframe herald-write-approvals.html §State 4: the settings write-tool list
// reads the canonical 19 names from shared/assistant.ts. Guards the regression
// where a hardcoded 13-name array hid six tools, truncated a stored selection
// on hydration, and wrote the filtered set back on Save.
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({
  settings: null as unknown,
  isLoading: false,
  saved: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../../lib/queries", () => ({
  useAssistantSettings: () => ({ data: h.settings, isLoading: h.isLoading }),
  useSaveAssistantWriteTools: () => ({
    mutate: (input: Record<string, unknown>) => {
      h.saved.push(input);
    },
    isPending: false,
  }),
}));

import { AssistantWriteToolsSection } from "./AssistantWriteToolsSection";
import { ASSISTANT_WRITE_TOOL_NAMES } from "../../../../shared/assistant";
import type { Project } from "../../../../shared/types";

const PROJECT = { id: "p1", name: "Emberfall", slug: "emberfall" } as unknown as Project;

// The six names the old 13-entry array dropped.
const PREVIOUSLY_DROPPED = ["delete_task", "delete_wiki_page", "delete_milestone", "archive_sprint", "delete_sprint", "move_swimlane"] as const;

function settings(over: { writeTools: string[] }) {
  return {
    projectId: "p1",
    searchProvider: null,
    hasSearchKey: false,
    urlAllowlist: null,
    primarySupportsImages: false,
    reasoningEffort: null,
    providerId: null,
    modelId: null,
    ...over,
  };
}

beforeEach(() => {
  h.settings = settings({ writeTools: [] });
  h.isLoading = false;
  h.saved = [];
});

describe("AssistantWriteToolsSection — canonical write-tool list", () => {
  it("renders one checkbox per canonical write tool", () => {
    render(<AssistantWriteToolsSection project={PROJECT} />);
    expect(ASSISTANT_WRITE_TOOL_NAMES).toHaveLength(19);
    expect(screen.getAllByRole("checkbox")).toHaveLength(19);
  });

  it("renders the count from the canonical list, never a literal", () => {
    render(<AssistantWriteToolsSection project={PROJECT} />);
    expect(screen.getByText(`${ASSISTANT_WRITE_TOOL_NAMES.length} write tools`)).toBeInTheDocument();
  });

  it("hydrates a stored 19-name selection with nothing dropped", () => {
    h.settings = settings({ writeTools: [...ASSISTANT_WRITE_TOOL_NAMES] });
    render(<AssistantWriteToolsSection project={PROJECT} />);

    expect(screen.getAllByRole("checkbox")).toHaveLength(19);
    for (const name of PREVIOUSLY_DROPPED) {
      expect(screen.getByRole("checkbox", { name })).toBeChecked();
    }
  });

  it("saves the full selection back — no write-back truncation", async () => {
    const stored = ASSISTANT_WRITE_TOOL_NAMES.filter((t) => t !== "delete_task");
    h.settings = settings({ writeTools: [...stored] });
    const user = userEvent.setup();
    render(<AssistantWriteToolsSection project={PROJECT} />);

    await user.click(screen.getByRole("checkbox", { name: "delete_task" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(h.saved).toHaveLength(1);
    const savedTools = h.saved[0]?.writeTools as string[];
    expect(savedTools).toHaveLength(ASSISTANT_WRITE_TOOL_NAMES.length);
    expect([...savedTools].sort()).toEqual([...ASSISTANT_WRITE_TOOL_NAMES].sort());
  });

  it("blocks a no-op Save when the selection is unchanged", async () => {
    h.settings = settings({ writeTools: [...ASSISTANT_WRITE_TOOL_NAMES] });
    const user = userEvent.setup();
    render(<AssistantWriteToolsSection project={PROJECT} />);

    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    await user.click(save);
    expect(h.saved).toHaveLength(0);
  });

  it("carries every persisted masked field forward on save", async () => {
    h.settings = {
      ...settings({ writeTools: [] }),
      searchProvider: "exa",
      urlAllowlist: "https://docs.example",
      primarySupportsImages: true,
      reasoningEffort: "high",
      providerId: "prov-1",
      modelId: "model-1",
      fallbackModelIds: ["model-2"],
    };
    const user = userEvent.setup();
    render(<AssistantWriteToolsSection project={PROJECT} />);

    await user.click(screen.getByRole("checkbox", { name: "create_task" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]).toMatchObject({
      searchProvider: "exa",
      urlAllowlist: "https://docs.example",
      primarySupportsImages: true,
      reasoningEffort: "high",
      providerId: "prov-1",
      modelId: "model-1",
      fallbackModelIds: ["model-2"],
      writeTools: ["create_task"],
    });
  });

  it("master toggle from empty selects all 19", async () => {
    const user = userEvent.setup();
    render(<AssistantWriteToolsSection project={PROJECT} />);

    const before = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(before.some((box) => box.checked)).toBe(false);

    const master = screen.getByRole("button", { name: "Write tools enabled" });
    expect(master).toHaveAttribute("aria-pressed", "false");
    await user.click(master);

    // Name stays constant; only aria-pressed flips.
    const masterAfter = screen.getByRole("button", { name: "Write tools enabled" });
    expect(masterAfter).toHaveAttribute("aria-pressed", "true");

    const after = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(after).toHaveLength(19);
    expect(after.every((box) => box.checked)).toBe(true);
  });

  it("documents the two gates, three modes and each mode's behavior", () => {
    const { container } = render(<AssistantWriteToolsSection project={PROJECT} />);

    expect(screen.getByText("Two gates, three modes.")).toBeInTheDocument();

    const note = container.querySelector(".responsive-note");
    expect(note).not.toBeNull();
    const text = note?.textContent ?? "";
    expect(text).toContain("Ask");
    expect(text).toContain("the model proposes, the turn suspends");
    expect(text).toContain("Auto");
    expect(text).toContain("executes immediately, with no proposal chips and no suspend");
    expect(text).toContain("Blocked");
    expect(text).toContain("writes are refused");
  });

  it("does not claim per-change approval is universal (no auto-approve copy)", () => {
    const { container } = render(<AssistantWriteToolsSection project={PROJECT} />);

    expect(container.textContent).not.toMatch(/no "auto-approve" anywhere|Every proposed write still requires explicit per-change approval/i);
  });
});
