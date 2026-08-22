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
}));

import { HeraldProviderSection } from "./HeraldSettingsSection";
import * as queries from "../../lib/queries";

const PROJECT = { id: "p1", slug: "nimbus", name: "Nimbus" } as unknown as Project;

const MASKED: HeraldSettingsMasked = {
  kind: "openai_compatible",
  baseUrl: "https://openrouter.ai/api/v1",
  model: "anthropic/claude-sonnet-4",
  hasKey: true,
  keyMask: "sk-…7890",
  searchProvider: null,
  hasSearchKey: false,
  searchKeyMask: null,
  urlAllowlist: null,
} as unknown as HeraldSettingsMasked;

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
    const [payload, options] = saveMutate.mock.calls[0];
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
    const payload = saveMutate.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.apiKey).toBeUndefined();
  });
});
