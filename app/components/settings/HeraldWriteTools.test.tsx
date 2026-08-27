// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { HeraldWriteToolsSection } from "./HeraldSettingsSection";
import type { HeraldSettingsMasked } from "../../../shared/herald";

const masked: HeraldSettingsMasked = {
  projectId: "p1",
  searchProvider: null,
  hasSearchKey: false,
  urlAllowlist: null,
  engine: "herald",
  engineSwitcherEnabled: true,
  primarySupportsImages: false,
  reasoningEffort: null,
  writeTools: ["create_task", "add_comment"],
  providerId: null,
  modelId: null,
  fallbackModelIds: ["gpt-x"],
};

const saveMock = vi.fn();

vi.mock("../../lib/queries", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useHeraldSettings: () => ({ data: masked, isLoading: false }),
  useSaveHeraldWriteTools: () => ({ mutate: saveMock, isPending: false }),
}));

const project = { id: "p1", name: "P", slug: "p" } as never;

describe("HeraldWriteToolsSection (herald-write-approvals.html State 4)", () => {
  beforeEach(() => {
    saveMock.mockClear();
  });

  it("renders the master toggle + all 13 tool checkboxes with stored selection", () => {
    render(<HeraldWriteToolsSection project={project} />);
    expect(screen.getByText("Write tools enabled")).toBeInTheDocument();
    for (const tool of [
      "create_task",
      "update_task",
      "move_task",
      "archive_task",
      "restore_task",
      "add_comment",
      "create_wiki_page",
      "edit_wiki_page",
      "create_milestone",
      "update_milestone",
      "archive_milestone",
      "create_sprint",
      "update_sprint",
    ]) {
      expect(screen.getByLabelText(tool)).toBeInTheDocument();
    }
    expect(screen.getByLabelText("create_task")).toBeChecked();
    expect(screen.getByLabelText("restore_task")).not.toBeChecked();
  });

  it("unticking the last tool flips the master gate off; re-enabling restores the full set", () => {
    render(<HeraldWriteToolsSection project={project} />);
    fireEvent.click(screen.getByLabelText("create_task"));
    fireEvent.click(screen.getByLabelText("add_comment"));
    expect(screen.getByLabelText("create_task")).not.toBeChecked();
    // Master toggle reflects empty selection.
    expect(screen.getByRole("button", { name: "Write tools on" })).not.toHaveClass("is-on");
    fireEvent.click(screen.getByRole("button", { name: "Write tools on" }));
    expect(screen.getByLabelText("update_sprint")).toBeChecked();
  });

  it("save PUTs writeTools alongside the stored provider fields", async () => {
    render(<HeraldWriteToolsSection project={project} />);
    fireEvent.click(screen.getByLabelText("move_task"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith({
        fallbackModelIds: ["gpt-x"],
        writeTools: ["create_task", "add_comment", "move_task"],
      })
    );
  });
});
