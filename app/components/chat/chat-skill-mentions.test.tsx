// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AssistantChatComposer } from "./AssistantChatComposer";
import { ChatComposerArea } from "./AssistantChatShell";
import { renderTokenized } from "../../lib/tokenizeTranscript";
import type { LexaSkill } from "../../../shared/types";

const CREATED = "2026-01-01T00:00:00Z";

const SKILLS: LexaSkill[] = [
  { id: "s1", name: "Status", description: "Status report", instructions: "", isBuiltin: false, createdAt: CREATED, updatedAt: CREATED },
  { id: "s2", name: "Review", description: "", instructions: "", isBuiltin: false, createdAt: CREATED, updatedAt: CREATED },
];

function renderComposer(skills: LexaSkill[] = SKILLS) {
  const onSend = vi.fn(() => true);
  const utils = render(
    <AssistantChatComposer
      slug="nimbus"
      skills={skills}
      streaming={false}
      busy409={false}
      suspendedLock={false}
      suspendCount={0}
      attachDisabled={false}
      onSend={onSend}
      onAbort={() => {}}
    />
  );
  return { ...utils, textarea: screen.getByLabelText("Message Assistant") as HTMLTextAreaElement, onSend };
}

function renderDockedDeck() {
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
    />
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("chat composer — $ skill mentions", () => {
  it("opens the popup on $ with the bound skills and its own header", () => {
    const { textarea } = renderComposer();
    fireEvent.change(textarea, { target: { value: "$" } });

    expect(screen.getByText("Skills — invoke with $")).toBeTruthy();
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(screen.getByRole("option", { name: "Review" })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Status/ })).toBeTruthy();
  });

  it("filters the bound skills by name as you type", () => {
    const { textarea } = renderComposer();
    fireEvent.change(textarea, { target: { value: "$rev" } });

    expect(screen.queryByRole("option", { name: /Status/ })).toBeNull();
    expect(screen.getByRole("option", { name: "Review" })).toBeTruthy();
  });

  it("inserts the clicked row's token when picking a non-first skill row", () => {
    const { textarea } = renderComposer();
    fireEvent.change(textarea, { target: { value: "$" } });

    const rows = screen.getAllByRole("option");
    expect(rows).toHaveLength(2);
    expect(rows[1]!.textContent).toContain("Status");
    fireEvent.mouseDown(rows[1]!);

    expect(textarea.value).toBe("$status ");
  });

  it("shows the empty-state copy when the agent has no bound skills", () => {
    const { textarea } = renderComposer([]);
    fireEvent.change(textarea, { target: { value: "$" } });

    expect(screen.getByText("No skills attached — add them in Settings")).toBeTruthy();
  });

  it("shows No matches when the bound list has nothing for the query", () => {
    const { textarea } = renderComposer();
    fireEvent.change(textarea, { target: { value: "$zzz" } });

    expect(screen.getByText("No matches")).toBeTruthy();
  });

  it("bare @ (empty query) renders default suggestions, never the No matches row", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: {
          tasks: [{ id: "t1", key: "NIM-1", title: "Task one" }],
          wikiPages: [{ id: "w1", slug: "setup", title: "Setup" }],
        },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { textarea } = renderComposer();
    fireEvent.change(textarea, { target: { value: "@" } });

    await waitFor(() => expect(screen.getByRole("option", { name: /NIM-1/ })).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/nimbus/mentions?q=");
    expect(screen.queryByText("No matches")).toBeNull();
    expect(screen.getByText("Tasks")).toBeTruthy();
    expect(screen.getByText("Wiki")).toBeTruthy();
  });

  it("typing after @ fetches with the query (filtering stays server-side)", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { tasks: [{ id: "t2", key: "NIM-2", title: "Payments" }], wikiPages: [] } }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { textarea } = renderComposer();
    fireEvent.change(textarea, { target: { value: "@pay" } });

    await waitFor(() => expect(screen.getByRole("option", { name: /NIM-2/ })).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/nimbus/mentions?q=pay");
    expect(screen.queryByText("No matches")).toBeNull();
  });

  it("renders the five @ entity sections from the mentions response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: {
            tasks: [{ id: "t1", key: "NIM-1", title: "Task one" }],
            wikiPages: [{ id: "w1", slug: "setup", title: "Setup" }],
            milestones: [{ id: "m1", name: "M1", slug: "m1", sublabel: "due 2026-02-01" }],
            swimlanes: [{ id: "l1", name: "Lane A", slug: "lane-a", sublabel: "feature" }],
            columns: [{ id: "c1", name: "In Progress", slug: "in-progress", sublabel: "position 2" }],
          },
        }),
      }))
    );

    const { textarea } = renderComposer();
    fireEvent.change(textarea, { target: { value: "@a" } });

    await waitFor(() => expect(screen.getByText("Tasks")).toBeTruthy());
    expect(screen.getByText("Wiki")).toBeTruthy();
    expect(screen.getByText("Milestones")).toBeTruthy();
    expect(screen.getByText("Swimlanes")).toBeTruthy();
    expect(screen.getByText("Columns")).toBeTruthy();
  });
});

describe("skill chip rendering + docked deck", () => {
  it("renders $Status as a mention-chip-skill chip", () => {
    const { container } = render(<div>{renderTokenized("Format it with $Status.", "nimbus")}</div>);
    const chip = container.querySelector(".mention-chip-skill");
    expect(chip).toBeTruthy();
    expect(chip!.textContent).toBe("$Status");
  });

  it("keeps the docked deck free of any SKILL control", () => {
    const { container } = renderDockedDeck();
    const rail = container.querySelector(".deck-rail")!;
    expect(rail.textContent).not.toMatch(/skill/i);
    expect(container.textContent).not.toMatch(/SKILL/);
  });
});
