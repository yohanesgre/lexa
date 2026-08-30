// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useSensors, useSensor, PointerSensor } from "@dnd-kit/core";
import { OptionForm } from "./OptionForm";
import { OptionSettingsSection } from "./OptionSettingsSection";
import { ColumnsSettingsSection } from "./ColumnsSettingsSection";
import { SwimlaneForm } from "./SwimlaneForm";
import { KanbanSettingsModal } from "./KanbanSettingsModal";
import type { Column, FieldOption, Swimlane } from "../../../shared/types";

const fetchMock = vi.fn();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const PRIORITY: FieldOption = { id: "pr-high", label: "High", color: "#FF4444", position: 0 };
const TYPE: FieldOption = { id: "tp-bug", label: "Bug", color: "#FF4444", position: 0 };
const COLUMN: Column = { id: "c1", projectId: "p1", name: "Todo", position: 0, color: "#888", wipLimit: 3, requiredFields: ["description"], githubState: "open", isDone: false };
const LANE: Swimlane = { id: "s1", projectId: "p1", name: "Backlog", description: "system lane", position: 0, dueAt: null, archivedAt: null, startAt: null, milestoneId: null, kind: "backlog" };
const MILESTONE: Swimlane = { id: "s2", projectId: "p1", name: "Sprint 8", description: "", position: 1, dueAt: "2026-09-01", archivedAt: null, startAt: null, milestoneId: null, kind: "sprint" };

function WithSensors({ children }: { children: ReactNode }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  return <>{children}</>;
}

describe("OptionForm", () => {
  function renderForm(props: Partial<Parameters<typeof OptionForm>[0]> = {}) {
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    render(
      <OptionForm kind="priority" option={null} isOpen onSubmit={onSubmit} onClose={onClose} {...props} />
    );
    return { onSubmit, onClose };
  }

  it("rejects an empty label", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();
    await user.click(screen.getByRole("button", { name: "Add Priority" }));
    expect(screen.getByText("Label is required")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
  it("submits the label and the selected swatch color", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();
    await user.type(screen.getByLabelText("Label"), "Blocker");
    await user.click(screen.getByRole("button", { name: "Select Red" }));
    await user.click(screen.getByRole("button", { name: "Add Priority" }));
    expect(onSubmit).toHaveBeenCalledWith({ label: "Blocker", color: "#FF4444" });
  });
});
describe("OptionSettingsSection", () => {
  it("renders options with labels and colors and wires Edit/Delete/Add", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const onAdd = vi.fn();
    render(
      <WithSensors>
        <OptionSettingsSection
          kind="priority" title="Priorities" description="First option is the create default."
          options={[PRIORITY, { ...PRIORITY, id: "pr-low", label: "Low", color: "#6B6560" }]}
          sensors={[]}
          onDragEnd={() => {}}
          onEdit={onEdit} onDelete={onDelete} onAdd={onAdd}
        />
      </WithSensors>
    );
    expect(screen.getByText("High")).toBeInTheDocument();
    expect(screen.getByText("Low")).toBeInTheDocument();
    expect(screen.getByText("#FF4444")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Edit priority" })[0]!);
    expect(onEdit).toHaveBeenCalledWith(PRIORITY);
    await user.click(screen.getAllByRole("button", { name: "Delete priority" })[0]!);
    expect(onDelete).toHaveBeenCalledWith(PRIORITY);
    // fixed: "Priorities" singularizes to "Priority" (was "Add Prioritie")
    await user.click(screen.getByRole("button", { name: "Add Priority" }));
    expect(onAdd).toHaveBeenCalled();
  });
});
describe("ColumnsSettingsSection", () => {
  it("renders column rows with WIP, required fields, and GitHub state", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    render(
      <WithSensors>
        <ColumnsSettingsSection
          columns={[COLUMN]} sensors={[]}
          onDragEnd={() => {}} onEdit={onEdit} onDelete={() => {}} onAdd={() => {}}
        />
      </WithSensors>
    );
    expect(screen.getByText("Todo")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument(); // wip limit
    expect(screen.getByText("description")).toBeInTheDocument(); // required fields
    expect(screen.getByText("open")).toBeInTheDocument(); // github state
    await user.click(screen.getByRole("button", { name: "Edit column" }));
    expect(onEdit).toHaveBeenCalledWith(COLUMN);
  });
});
describe("SwimlaneForm", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(json({ data: [] }));
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    queryClient.clear();
  });

  function renderForm(props: Partial<Parameters<typeof SwimlaneForm>[0]> = {}) {
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    render(
      <QueryClientProvider client={queryClient}>
        <SwimlaneForm slug="demo" swimlane={null} isOpen onSubmit={onSubmit} onClose={onClose} {...props} />
      </QueryClientProvider>
    );
    return { onSubmit, onClose };
  }

  it("rejects an empty name", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();
    await user.click(screen.getByRole("button", { name: "Create Swimlane" }));
    expect(screen.getByText("Name is required")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
describe("KanbanSettingsModal integration (option + column mutations)", () => {
  const routes = new Map<string, unknown>();
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    routes.clear();
    routes.set("GET /api/projects/demo/columns", { data: [COLUMN] });
    routes.set("GET /api/projects/demo/swimlanes", { data: [LANE, MILESTONE] });
    routes.set("GET /api/projects/demo/field-config", { priorities: [PRIORITY], types: [TYPE] });
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const key = `${init?.method ?? "GET"} ${url}`;
      const hit = routes.get(key) ?? routes.get(`GET ${url}`);
      if (hit === undefined) return Promise.reject(new Error(`unmocked: ${key}`));
      if (hit === 204) return Promise.resolve(new Response(null, { status: 204 }));
      return Promise.resolve(json(hit));
    });
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    queryClient.clear();
  });

  function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }

  it("closed modal fires no settings fetches; open modal renders sections from data", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <KanbanSettingsModal slug="demo" isOpen={false} onClose={() => {}} />,
      { wrapper }
    );
    expect(fetchMock.mock.calls).toHaveLength(0);
    rerender(<KanbanSettingsModal slug="demo" isOpen onClose={() => {}} />);
    await waitFor(() => {
      expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("/columns"))).toHaveLength(1);
    });
    expect(await screen.findByText("Board Settings")).toBeInTheDocument();
    expect(await screen.findByText("Priorities")).toBeInTheDocument();
    expect(screen.getByText("Types")).toBeInTheDocument();
    // both add buttons singularize correctly
    expect(screen.getByRole("button", { name: "Add Priority" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Type" })).toBeInTheDocument();
  });
});
