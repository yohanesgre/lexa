// @vitest-environment jsdom
// Wireframe settings-project-herald.html §Jev advisory: per-project opt-in
// default off. When the server reports `available === false` (global config
// missing/disabled or key-less) the toggle is disabled with the exact
// "Configure Jev in Admin → Assistant → Providers & Models" notice. When
// available, the toggle PUTs `{ enabled }`.
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({
  data: null as unknown,
  saved: [] as unknown[],
  pending: false,
  isError: false,
}));

vi.mock("../../lib/queries/assistant-admin", () => ({
  useProjectJev: () => ({ data: h.data, isLoading: false, isError: h.isError }),
  useSetProjectJev: () => ({
    mutate: (input: unknown, opts?: { onSuccess?: () => void }) => { h.saved.push(input); opts?.onSuccess?.(); },
    isPending: h.pending,
  }),
}));

import { AssistantProjectJevSection } from "./AssistantProjectJevSection";
import type { Project } from "../../../shared/types";
import type { AssistantJevProjectPublic } from "../../../shared/assistant";

const PROJECT = { id: "p1", name: "Emberfall", slug: "emberfall" } as unknown as Project;

function row(over: Partial<AssistantJevProjectPublic>): AssistantJevProjectPublic {
  return { projectId: "p1", enabled: false, available: false, createdAt: null, updatedAt: null, ...over };
}

beforeEach(() => {
  h.data = row({});
  h.saved = [];
  h.pending = false;
  h.isError = false;
});

describe("AssistantProjectJevSection — structure", () => {
  it("keeps the heading with its markers", () => {
    render(<AssistantProjectJevSection project={PROJECT} />);
    expect(screen.getByRole("heading", { name: "Jev advisory" })).toBeInTheDocument();
    expect(screen.getByText("direct Typesafe REST")).toBeInTheDocument();
    expect(screen.getByText("default off")).toBeInTheDocument();
  });

  it("renders a distinct error affordance on a failed first GET — never an eternal Loading…", () => {
    h.data = null;
    h.isError = true;
    render(<AssistantProjectJevSection project={PROJECT} />);
    expect(screen.getByText("Could not load Jev advisory settings.")).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });

  it("keeps rendering the card when a background refetch fails (no swap)", () => {
    // isError with cached data is a failed REFETCH, not a first-load failure —
    // the card must survive.
    h.data = row({ available: true });
    h.isError = true;
    render(<AssistantProjectJevSection project={PROJECT} />);
    expect(screen.queryByText("Could not load Jev advisory settings.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Jev advisory" })).toBeInTheDocument();
  });
});

describe("AssistantProjectJevSection — unavailable (available === false)", () => {
  it("renders the disabled toggle with the exact notice", () => {
    render(<AssistantProjectJevSection project={PROJECT} />);
    const toggle = screen.getByRole("button", { name: "Jev advisory" });
    expect(toggle).toBeDisabled();
    expect(toggle).not.toHaveClass("is-on");
    expect(screen.getByText("Jev is not configured globally.")).toBeInTheDocument();
    expect(screen.getByText("Configure Jev in Admin → Assistant → Providers & Models")).toBeInTheDocument();
  });

  it("never PUTs while unavailable", async () => {
    const user = userEvent.setup();
    render(<AssistantProjectJevSection project={PROJECT} />);
    await user.click(screen.getByRole("button", { name: "Jev advisory" }));
    expect(h.saved).toEqual([]);
  });
});

describe("AssistantProjectJevSection — available", () => {
  it("offers the toggle and PUTs the flipped value when opt-in is off", async () => {
    h.data = row({ available: true });
    const user = userEvent.setup();
    render(<AssistantProjectJevSection project={PROJECT} />);
    const toggle = screen.getByRole("button", { name: "Jev advisory" });
    expect(toggle).not.toBeDisabled();
    expect(toggle).not.toHaveClass("is-on");
    expect(screen.getByText(/No Jev preflight and no/)).toBeInTheDocument();

    await user.click(toggle);
    expect(h.saved).toEqual([{ enabled: true }]);
  });

  it("reflects a stored row as enabled and PUTs the off value", async () => {
    h.data = row({ available: true, enabled: true, createdAt: "t", updatedAt: "t" });
    const user = userEvent.setup();
    render(<AssistantProjectJevSection project={PROJECT} />);
    const toggle = screen.getByRole("button", { name: "Jev advisory" });
    expect(toggle).toHaveClass("is-on");
    expect(screen.getByText(/Advisory preflight \+/)).toBeInTheDocument();

    await user.click(toggle);
    expect(h.saved).toEqual([{ enabled: false }]);
  });
});
