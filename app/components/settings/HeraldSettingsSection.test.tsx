// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { Project } from "../../../shared/types";
import type { HeraldSettingsMasked } from "../../../shared/herald";

vi.mock("../../lib/queries", () => ({
  useHeraldSettings: vi.fn(),
  useSaveHeraldSettings: vi.fn(),
  useTestHeraldSettings: vi.fn(),
  useFetchHeraldModels: vi.fn(),
  useHeraldMemory: vi.fn(() => ({ data: [] })),
  useAddHeraldMemory: vi.fn(() => ({ mutateAsync: vi.fn() })),
  useRemoveHeraldMemory: vi.fn(() => ({ mutateAsync: vi.fn() })),
  useAgents: vi.fn(() => ({ data: [] })),
  useSkills: vi.fn(() => ({ data: [] })),
  useReplaceAgentSkills: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));

import { HeraldProviderSection, HeraldEngineSection, AgentSkillAvailabilitySection } from "./HeraldSettingsSection";
import * as queries from "../../lib/queries";

const PROJECT = { id: "p1", slug: "nimbus", name: "Nimbus" } as unknown as Project;

const MASKED: HeraldSettingsMasked = {
  projectId: "p1",
  kind: "openai_compatible",
  baseUrl: "https://openrouter.ai/api/v1",
  model: "anthropic/claude-sonnet-4",
  hasKey: true,
  keyMask: "sk-…7890",
  searchProvider: null,
  hasSearchKey: false,
  urlAllowlist: null,
  engine: "herald",
  engineSwitcherEnabled: false,
  primarySupportsImages: false,
  visionModel: null,
  reasoningEffort: "low",
} as HeraldSettingsMasked;

function mockQueries(settings: HeraldSettingsMasked | null) {
  const saveMutate = vi.fn();
  vi.mocked(queries.useHeraldSettings).mockReturnValue({ data: settings, isLoading: false } as never);
  vi.mocked(queries.useSaveHeraldSettings).mockReturnValue({ mutate: saveMutate, isPending: false } as never);
  vi.mocked(queries.useTestHeraldSettings).mockReturnValue({ mutate: vi.fn(), isPending: false, isSuccess: false, isError: false } as never);
  vi.mocked(queries.useFetchHeraldModels).mockReturnValue({ mutate: vi.fn(), isPending: false, data: undefined } as never);
  return { saveMutate };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Herald provider — API key field (rework)", () => {
  it("shows the saved badge OUTSIDE the input with the server mask; input is editable + empty", () => {
    mockQueries(MASKED);
    render(<HeraldProviderSection project={PROJECT} />);
    const badge = screen.getByTitle("Stored server-side — never serialized to the browser");
    expect(badge.textContent).toContain("Saved · ");
    expect(badge.textContent).toContain("sk-…7890");
    const input = screen.getByLabelText("API key") as HTMLInputElement;
    expect(input.readOnly).toBe(false);
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("Type to replace sk-…7890");
    // No mode-switch buttons survive the rework.
    expect(screen.queryByRole("button", { name: /replace/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /keep saved/i })).toBeNull();
    // Eye/reveal dropped deliberately.
    expect(screen.queryByRole("button", { name: /reveal|hide|show/i })).toBeNull();
  });

  it("typing updates state and Save sends the typed value; success clears back to keep-state", () => {
    const { saveMutate } = mockQueries(MASKED);
    render(<HeraldProviderSection project={PROJECT} />);
    const input = screen.getByLabelText("API key");
    fireEvent.change(input, { target: { value: "sk-live-new-key" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(saveMutate).toHaveBeenCalledTimes(1);
    const [payload, options] = saveMutate.mock.calls[0]!;
    expect((payload as Record<string, unknown>).apiKey).toBe("sk-live-new-key");
    // Success callback clears the field (empty = keep stored afterwards).
    act(() => {
      (options as { onSuccess?: () => void }).onSuccess?.();
    });
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("no key yet: no badge, plain placeholder, empty field still omits apiKey from payload", () => {
    // hasKey is a `true` literal on the masked type — "no key" IS settings=null
    // (PROVIDER_NOT_CONFIGURED resolves to null in useHeraldSettings).
    const { saveMutate } = mockQueries(null);
    render(<HeraldProviderSection project={PROJECT} />);
    expect(screen.queryByText(/saved · /i)).toBeNull();
    expect((screen.getByLabelText("API key") as HTMLInputElement).placeholder).toBe("sk-…");
    // Base URL + model are required before Save enables.
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://x.test/v1" } });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "m1" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    const payload = saveMutate.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.apiKey).toBeUndefined();
  });
});

describe("Herald engine section", () => {
  it("segmented control persists the engine immediately, riding on the stored base fields", () => {
    const { saveMutate } = mockQueries(MASKED);
    render(<HeraldEngineSection project={PROJECT} />);
    fireEvent.click(screen.getByRole("radio", { name: /blacksmith/i }));
    expect(saveMutate).toHaveBeenCalledTimes(1);
    const payload = saveMutate.mock.calls[0]![0] as Record<string, unknown>;
    // PUT contract: kind/baseUrl/model are required — partial saves carry
    // the stored values so only engine actually changes.
    expect(payload).toMatchObject({
      kind: "openai_compatible",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "anthropic/claude-sonnet-4",
      engine: "blacksmith",
    });
  });

  it("switcher toggle sends engineSwitcherEnabled and renders hidden-by-default semantics", () => {
    const { saveMutate } = mockQueries(MASKED);
    render(<HeraldEngineSection project={PROJECT} />);
    const toggle = screen.getByRole("switch", { name: "Engine switcher off" });
    fireEvent.click(toggle);
    const payload = saveMutate.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.engineSwitcherEnabled).toBe(true);
  });
});

describe("Herald vision fields (folded into provider section)", () => {
  it("save payload carries primarySupportsImages + visionModel riding the Herald provider base fields", () => {
    const { saveMutate } = mockQueries(MASKED);
    render(<HeraldProviderSection project={PROJECT} />);
    fireEvent.click(screen.getByLabelText("Primary model accepts images directly"));
    fireEvent.change(screen.getByLabelText("Vision model"), { target: { value: "gpt-5-vision" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    const payload = saveMutate.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      kind: "openai_compatible",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "anthropic/claude-sonnet-4",
      primarySupportsImages: true,
      visionModel: "gpt-5-vision",
    });
    // Cross-provider vision is gone — no provider/key fields in the payload.
    expect(payload.visionProvider).toBeUndefined();
    expect(payload.visionApiKey).toBeUndefined();
  });

  it("no provider select or key field rendered; empty vision model saves null", () => {
    const { saveMutate } = mockQueries(MASKED);
    render(<HeraldProviderSection project={PROJECT} />);
    expect(screen.queryByLabelText("Vision provider")).toBeNull();
    expect(screen.queryByLabelText("Vision API key")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Vision" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    const payload = saveMutate.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.visionModel).toBeNull();
  });
});

describe("Herald thinking effort (settings-project-herald.html)", () => {
  it("select renders between Model and vision with the exact option set, hydrated from the masked view", () => {
    mockQueries(MASKED);
    render(<HeraldProviderSection project={PROJECT} />);
    const select = screen.getByLabelText("Thinking effort") as HTMLSelectElement;
    expect(select.value).toBe("low");
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toEqual(["Default (none set)", "Minimal", "Low", "Medium", "High"]);
    expect(screen.getByText(/Requests more or less reasoning from the model/i)).toBeInTheDocument();
    // Field order: Thinking effort sits after the Model field, before vision.
    const fields = Array.from(document.querySelectorAll(".field-label")).map((el) => el.textContent);
    expect(fields.indexOf("Model")).toBeLessThan(fields.indexOf("Thinking effort"));
    expect(fields.indexOf("Thinking effort")).toBeLessThan(fields.indexOf("Primary model vision"));
  });

  it("Save sends the picked level; clearing back to Default (none set) saves null", () => {
    const { saveMutate } = mockQueries(MASKED);
    render(<HeraldProviderSection project={PROJECT} />);
    fireEvent.change(screen.getByLabelText("Thinking effort"), { target: { value: "high" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    let payload = saveMutate.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.reasoningEffort).toBe("high");

    fireEvent.change(screen.getByLabelText("Thinking effort"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    payload = saveMutate.mock.calls[1]![0] as Record<string, unknown>;
    expect(payload.reasoningEffort).toBeNull();
  });

  it("unset project (null) hydrates to Default (none set)", () => {
    mockQueries({ ...MASKED, reasoningEffort: null });
    render(<HeraldProviderSection project={PROJECT} />);
    expect((screen.getByLabelText("Thinking effort") as HTMLSelectElement).value).toBe("");
  });
});

describe("Agent skill availability", () => {
  it("renders exactly the two builtin agents and writes junction rows immediately on toggle", () => {
    vi.mocked(queries.useAgents).mockReturnValue({
      data: [
        { id: "hearth-herald", name: "Herald Agent", skillIds: ["requirements"] },
        { id: "hearth-blacksmith", name: "Blacksmith Agent", skillIds: [] },
      ],
    } as never);
    vi.mocked(queries.useSkills).mockReturnValue({
      data: [
        { id: "requirements", name: "Requirements" },
        { id: "review", name: "Review" },
      ],
    } as never);
    const replaceMutate = vi.fn();
    vi.mocked(queries.useReplaceAgentSkills).mockReturnValue({ mutate: replaceMutate, isPending: false } as never);

    render(<AgentSkillAvailabilitySection projectId="p1" />);
    expect(screen.getByText("Herald Agent")).toBeInTheDocument();
    expect(screen.getByText("Blacksmith Agent")).toBeInTheDocument();

    // Attaching Review to Herald Agent PUTs the full new junction set.
    fireEvent.click(screen.getByLabelText("Review — Herald Agent"));
    expect(replaceMutate).toHaveBeenCalledWith({ id: "hearth-herald", skillIds: ["requirements", "review"] });

    // Detaching Requirements from Blacksmith Agent (empty → stays empty).
    fireEvent.click(screen.getByLabelText("Requirements — Blacksmith Agent"));
    expect(replaceMutate).toHaveBeenLastCalledWith({ id: "hearth-blacksmith", skillIds: ["requirements"] });
  });
});