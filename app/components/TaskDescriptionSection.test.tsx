// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("./hearth/SourcesSection", () => ({ SourcesSection: () => <div data-testid="sources" /> }));
vi.mock("./hearth/LinksSection", () => ({ LinksSection: () => <div data-testid="links" /> }));
vi.mock("./DescriptionEditor", () => ({ DescriptionEditor: () => null }));
vi.mock("./tiptap-render", () => ({ renderDoc: () => null }));

import { TaskDescriptionSection } from "./TaskDescriptionSection";

describe("TaskDescriptionSection section order", () => {
  it("renders Sources before Links (task-detail.html:301,338,372)", () => {
    render(
      <TaskDescriptionSection
        isCreate={false}
        slug="demo"
        task={{ id: "t1", description: { type: "doc", content: [] } }}
        emptyDoc={{ type: "doc", content: [] }}
        taskTitles={new Map()}
        taskKeys={new Map()}
        editingDescription={false}
        setEditingDescription={vi.fn()}
        setCreateDescription={vi.fn()}
        onUpdate={vi.fn()}
      />
    );
    const order = screen.getAllByTestId(/sources|links/).map((n) => n.getAttribute("data-testid"));
    expect(order).toEqual(["sources", "links"]);
  });
});
