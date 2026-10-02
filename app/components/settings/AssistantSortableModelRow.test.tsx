// @vitest-environment jsdom
// Wireframe settings-workspace.html §models: each row toggle is named by its
// Model ID cell value, never by state. Name stays constant; state is aria-pressed.
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({ mutate: vi.fn() }));

vi.mock("../../lib/queries/assistant-admin", () => ({
  useUpdateProviderModel: () => ({ mutate: h.mutate }),
}));

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));

import { AssistantSortableModelRow } from "./AssistantSortableModelRow";
import type { AssistantProviderModel } from "../../../shared/assistant";

function model(over: Partial<AssistantProviderModel>): AssistantProviderModel {
  return {
    id: "m1",
    providerId: "p1",
    modelId: "anthropic/claude-sonnet-4",
    kind: "openai_compatible",
    priority: 1,
    enabled: true,
    ...over,
  };
}

function renderRow(m: AssistantProviderModel) {
  return render(
    <table>
      <tbody>
        <AssistantSortableModelRow providerId="p1" model={m} />
      </tbody>
    </table>
  );
}

describe("AssistantSortableModelRow — toggle name", () => {
  it("names the toggle with the Model ID and keeps it constant across states", () => {
    const { rerender } = renderRow(model({ enabled: true }));
    expect(screen.getByRole("button", { name: "anthropic/claude-sonnet-4" })).toHaveAttribute("aria-pressed", "true");

    rerender(
      <table>
        <tbody>
          <AssistantSortableModelRow providerId="p1" model={model({ enabled: false })} />
        </tbody>
      </table>
    );
    expect(screen.getByRole("button", { name: "anthropic/claude-sonnet-4" })).toHaveAttribute("aria-pressed", "false");
  });
});
