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

  it("saves the full hydrated selection back — no write-back truncation", async () => {
    h.settings = settings({ writeTools: [...ASSISTANT_WRITE_TOOL_NAMES] });
    const user = userEvent.setup();
    render(<AssistantWriteToolsSection project={PROJECT} />);

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]?.writeTools).toEqual([...ASSISTANT_WRITE_TOOL_NAMES]);
  });

  it("master toggle from empty selects all 19", async () => {
    const user = userEvent.setup();
    render(<AssistantWriteToolsSection project={PROJECT} />);

    const before = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(before.some((box) => box.checked)).toBe(false);

    await user.click(screen.getByRole("button", { name: "Write tools on" }));

    const after = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(after).toHaveLength(19);
    expect(after.every((box) => box.checked)).toBe(true);
  });
});
