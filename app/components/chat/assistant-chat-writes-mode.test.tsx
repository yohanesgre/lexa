// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { WritesPicker, WritesModeSummary, WRITES_EMPTY_HINT } from "./WritesModePicker";
import { ChatComposerArea } from "./AssistantChatShell";
import { agentSendMetadata } from "../../lib/assistant-agent-adapter";
import { chatStreamBody, isPermissionAuthoritative, noWriteToolsAllowed, resolvePermissionMode } from "./assistant-chat-logic";
import type { LexaSkill } from "../../../shared/types";

const SKILLS: LexaSkill[] = [
  { id: "s1", name: "Status", description: "", instructions: "", isBuiltin: false, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
];

describe("WritesPicker — desktop rail control", () => {
  function renderPicker(overrides: Partial<Parameters<typeof WritesPicker>[0]> = {}) {
    const onChange = vi.fn();
    const utils = render(<WritesPicker mode="ask" onChange={onChange} {...overrides} />);
    return { ...utils, onChange };
  }

  it("reads the mode label and keeps Ask muted", () => {
    const { container } = renderPicker();
    const chip = screen.getByLabelText("Write permission mode");
    expect(chip.textContent).toContain("Ask");
    expect(chip.className).not.toContain("is-set");
    expect(container.querySelectorAll(".deck-chip")).toHaveLength(1);
  });

  it("tints Auto and Blocked with the is-set treatment", () => {
    const auto = renderPicker({ mode: "auto" });
    expect(auto.container.querySelector(".deck-chip")!.className).toContain("is-set");
    expect(screen.getByLabelText("Write permission mode").textContent).toContain("Auto");
    auto.unmount();

    const blocked = renderPicker({ mode: "deny" });
    expect(blocked.container.querySelector(".deck-chip")!.className).toContain("is-set");
    expect(screen.getByLabelText("Write permission mode").textContent).toContain("Blocked");
  });

  it("opens the write-permission listbox and picks a mode", () => {
    const { onChange } = renderPicker();
    fireEvent.click(screen.getByLabelText("Write permission mode"));

    const listbox = screen.getByRole("listbox", { name: "Write permission mode" });
    expect(within(listbox).getByText("Write permission")).toBeTruthy();
    expect(within(listbox).getAllByRole("option")).toHaveLength(3);
    expect(within(listbox).getByRole("option", { name: "Ask" })).toHaveAttribute("aria-selected", "true");

    fireEvent.click(within(listbox).getByRole("option", { name: "Auto" }));
    expect(onChange).toHaveBeenCalledWith("auto");
    expect(screen.queryByRole("listbox", { name: "Write permission mode" })).toBeNull();
  });

  it("supports Arrow/Home/End/Escape keyboard navigation", () => {
    renderPicker();
    fireEvent.click(screen.getByLabelText("Write permission mode"));
    const options = screen.getAllByRole("option");
    options[0]!.focus();

    fireEvent.keyDown(options[0]!, { key: "ArrowDown" });
    expect(options[1]!).toHaveFocus();
    fireEvent.keyDown(options[1]!, { key: "ArrowDown" });
    expect(options[2]!).toHaveFocus();
    fireEvent.keyDown(options[2]!, { key: "ArrowDown" });
    expect(options[0]!).toHaveFocus();
    fireEvent.keyDown(options[0]!, { key: "ArrowUp" });
    expect(options[2]!).toHaveFocus();
    fireEvent.keyDown(options[2]!, { key: "Home" });
    expect(options[0]!).toHaveFocus();
    fireEvent.keyDown(options[0]!, { key: "End" });
    expect(options[2]!).toHaveFocus();

    fireEvent.keyDown(options[2]!, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Write permission mode" })).toBeNull();
  });

  it("locks the chip while a stream runs", () => {
    renderPicker({ disabled: true });
    expect(screen.getByLabelText("Write permission mode")).toBeDisabled();
  });

  it("locks the chip and points at the hint when the project allows no write tools", () => {
    renderPicker({ noWriteTools: true });
    const chip = screen.getByLabelText("Write permission mode");
    expect(chip).toBeDisabled();
    expect(chip).toHaveAttribute("aria-describedby", "writes-empty-hint");
    // The hint is a `.deck-rail` sibling rendered by the composer shell, not by
    // the picker itself (wireframe parity).
    expect(screen.queryByText(WRITES_EMPTY_HINT)).toBeNull();
  });

  it("links the trigger to the menu id while open (wireframe parity)", () => {
    renderPicker();
    const chip = screen.getByLabelText("Write permission mode");
    expect(chip).not.toHaveAttribute("aria-controls");
    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-controls", "writes-menu");
    expect(document.getElementById("writes-menu")).toBeTruthy();
    expect(screen.getByRole("listbox", { name: "Write permission mode" })).toBeTruthy();
  });
});

describe("WritesModeSummary — mobile sheet", () => {
  function renderSummary(overrides: Partial<Parameters<typeof WritesModeSummary>[0]> = {}) {
    const onChange = vi.fn();
    const utils = render(<WritesModeSummary mode="ask" disabled={false} onChange={onChange} {...overrides} />);
    return { ...utils, onChange };
  }

  it("renders ONE summary chip reading the mode", () => {
    const { container } = renderSummary();
    expect(container.querySelectorAll(".deck-summary-chip")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Ask" })).toBeTruthy();
  });

  it("opens the Writes sheet and picks a mode", () => {
    const { onChange } = renderSummary();
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Writes")).toBeTruthy();
    expect(within(dialog).getByRole("listbox", { name: "Write permission mode" })).toBeTruthy();
    expect(within(dialog).getByRole("option", { name: "Blocked" })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("option", { name: "Blocked" }));
    expect(onChange).toHaveBeenCalledWith("deny");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("dismisses on Escape and returns focus to the summary chip", () => {
    renderSummary();
    const chip = screen.getByRole("button", { name: "Ask" });
    chip.focus();
    fireEvent.click(chip);
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(chip).toHaveFocus();
  });

  it("locks the summary chip when write tools are empty", () => {
    renderSummary({ noWriteTools: true });
    const chip = screen.getByRole("button", { name: "Ask" });
    expect(chip).toBeDisabled();
    expect(chip).toHaveAttribute("aria-describedby", "writes-empty-hint");
  });
});

function renderComposerArea(overrides: Partial<Parameters<typeof ChatComposerArea>[0]> = {}) {
  return render(
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
}

describe("ChatComposerArea — Writes rail placement", () => {
  it("places Writes beside Effort in the desktop rail", () => {
    const { container } = renderComposerArea();
    const rail = container.querySelector(".deck-rail")!;
    expect(within(rail as HTMLElement).getByText("Writes")).toBeTruthy();
    expect(rail.contains(screen.getByLabelText("Write permission mode"))).toBe(true);
  });

  it("collapses both controls to summary chips on mobile", () => {
    const { container } = renderComposerArea({ isMobileComposer: true });
    const rail = container.querySelector(".deck-rail")!;
    expect(rail.querySelectorAll(".deck-summary-chip")).toHaveLength(2);
    expect(within(rail as HTMLElement).getByRole("button", { name: "Ask" })).toBeTruthy();
    expect(within(rail as HTMLElement).getByRole("button", { name: "default (medium)" })).toBeTruthy();
  });

  it("locks the Writes control while streaming", () => {
    renderComposerArea({ streaming: true });
    expect(screen.getByLabelText("Write permission mode")).toBeDisabled();
  });

  it("shows the no-write-tools hint in the rail", () => {
    renderComposerArea({ noWriteTools: true });
    expect(screen.getByText(WRITES_EMPTY_HINT)).toBeTruthy();
    expect(screen.getByLabelText("Write permission mode")).toBeDisabled();
  });
});

describe("Writes mode envelope", () => {
  it("carries permissionMode into the agent send metadata", () => {
    expect(agentSendMetadata({ chatId: "c1", permissionMode: "deny" })).toEqual({ chatId: "c1", permissionMode: "deny" });
    expect(agentSendMetadata({ chatId: "c1" })).toEqual({ chatId: "c1" });
  });

  it("carries the current mode on every stream body, including ask", () => {
    const auto = chatStreamBody({ projectId: "p1", chatId: "c1", message: "hi", effort: "", permissionMode: "auto" });
    expect(auto.permissionMode).toBe("auto");
    const ask = chatStreamBody({ projectId: "p1", chatId: "c1", message: "hi", effort: "", permissionMode: "ask" });
    expect(ask.permissionMode).toBe("ask");
  });

  it("omits permissionMode when the page has no authoritative value", () => {
    const body = chatStreamBody({ projectId: "p1", chatId: "c1", message: "hi", effort: "" });
    expect(body).not.toHaveProperty("permissionMode");
  });
});

describe("isPermissionAuthoritative — envelope guard", () => {
  it("is authoritative for an in-session pick on this thread", () => {
    expect(isPermissionAuthoritative({ chatId: "t1", selection: { chatId: "t1" }, transcriptChatId: undefined })).toBe(true);
  });

  it("is authoritative when this thread's transcript is loaded", () => {
    expect(isPermissionAuthoritative({ chatId: "t1", selection: null, transcriptChatId: "t1" })).toBe(true);
  });

  it("is NOT authoritative for a fresh, unhydrated thread", () => {
    expect(isPermissionAuthoritative({ chatId: "t1", selection: null, transcriptChatId: undefined })).toBe(false);
  });

  it("is NOT authoritative for another thread's transcript or pick", () => {
    expect(isPermissionAuthoritative({ chatId: "t2", selection: { chatId: "t1" }, transcriptChatId: "t1" })).toBe(false);
  });

  it("treats a landing pick (empty thread id) as authoritative for the minted thread", () => {
    expect(isPermissionAuthoritative({ chatId: "", selection: { chatId: "" }, transcriptChatId: undefined })).toBe(true);
  });
});

describe("noWriteToolsAllowed — settings gate", () => {
  it("locks only once a settled settings read proves the allowlist empty", () => {
    expect(noWriteToolsAllowed({ writeTools: [] }, false)).toBe(true);
  });

  it("stays open while settings load, when absent, or when tools are allowed", () => {
    expect(noWriteToolsAllowed({ writeTools: [] }, true)).toBe(false);
    expect(noWriteToolsAllowed(null, false)).toBe(false);
    expect(noWriteToolsAllowed({ writeTools: ["create_task"] }, false)).toBe(false);
  });
});

describe("resolvePermissionMode — hydration + thread switch", () => {
  it("seeds from the transcript when the thread has no in-session pick", () => {
    expect(resolvePermissionMode({ chatId: "t1", selection: null, transcriptChatId: "t1", transcriptMode: "auto" })).toBe("auto");
  });

  it("falls back to ask when the transcript has not loaded", () => {
    expect(resolvePermissionMode({ chatId: "t1", selection: null, transcriptChatId: undefined, transcriptMode: undefined })).toBe("ask");
  });

  it("ignores a stale transcript from another thread", () => {
    expect(resolvePermissionMode({ chatId: "t2", selection: null, transcriptChatId: "t1", transcriptMode: "auto" })).toBe("ask");
  });

  it("lets the active thread's in-session pick win", () => {
    expect(resolvePermissionMode({ chatId: "t1", selection: { chatId: "t1", value: "deny" }, transcriptChatId: "t1", transcriptMode: "ask" })).toBe("deny");
  });

  it("re-seeds on thread switch after a pick elsewhere", () => {
    const selection = { chatId: "t1", value: "deny" as const };
    expect(resolvePermissionMode({ chatId: "t2", selection, transcriptChatId: "t2", transcriptMode: "auto" })).toBe("auto");
  });
});
