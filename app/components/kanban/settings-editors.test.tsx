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
import { SwimlanesSettingsSection } from "./SwimlanesSettingsSection";
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

  it("edit mode seeds the option and titles the dialog Edit", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm({ option: PRIORITY });
    expect(screen.getByText("Edit Priority")).toBeInTheDocument();
    expect((screen.getByLabelText("Label") as HTMLInputElement).value).toBe("High");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    expect(onSubmit).toHaveBeenCalledWith({ label: "High", color: "#FF4444" });
  });

  it("type kind titles the dialog Add Type", () => {
    renderForm({ kind: "type" });
    expect(screen.getByRole("heading", { name: "Add Type" })).toBeInTheDocument();
  });

  it("renders nothing when closed", () => {
    renderForm({ isOpen: false });
    expect(screen.queryByText("Add Priority")).not.toBeInTheDocument();
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

  it("shows the empty state when no options are configured", () => {
    render(
      <WithSensors>
        <OptionSettingsSection
          kind="priority" title="Priorities" description="d"
          options={[]} sensors={[]}
          onDragEnd={() => {}} onEdit={() => {}} onDelete={() => {}} onAdd={() => {}}
        />
      </WithSensors>
    );
    expect(screen.getByText("No priorities configured.")).toBeInTheDocument();
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

  it("shows dashes for columns without color/wip/github state", () => {
    const plain: Column = { ...COLUMN, color: null as never, wipLimit: null, requiredFields: [], githubState: null, isDone: false };
    render(
      <WithSensors>
        <ColumnsSettingsSection
          columns={[plain]} sensors={[]}
          onDragEnd={() => {}} onEdit={() => {}} onDelete={() => {}} onAdd={() => {}}
        />
      </WithSensors>
    );
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("None")).toBeInTheDocument();
  });
});

describe("SwimlanesSettingsSection", () => {
  it("renders lanes and shows the description button (truncated)", async () => {
    const user = userEvent.setup();
    const onShowDescription = vi.fn();
    render(
      <WithSensors>
        <SwimlanesSettingsSection
          swimlanes={[LANE]} sensors={[]}
          onDragEnd={() => {}} onEdit={() => {}} onDelete={() => {}} onAdd={() => {}}
          onShowDescription={onShowDescription}
        />
      </WithSensors>
    );
    await user.click(screen.getByRole("button", { name: "system lane" }));
    expect(onShowDescription).toHaveBeenCalledWith(LANE);
  });

  it("wires Add/Edit/Delete callbacks", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const onAdd = vi.fn();
    render(
      <WithSensors>
        <SwimlanesSettingsSection
          swimlanes={[MILESTONE]} sensors={[]}
          onDragEnd={() => {}} onEdit={onEdit} onDelete={onDelete} onAdd={onAdd}
          onShowDescription={() => {}}
        />
      </WithSensors>
    );
    await user.click(screen.getByRole("button", { name: "Edit swimlane" }));
    expect(onEdit).toHaveBeenCalledWith(MILESTONE);
    await user.click(screen.getByRole("button", { name: "Delete swimlane" }));
    expect(onDelete).toHaveBeenCalledWith(MILESTONE);
    await user.click(screen.getByRole("button", { name: "Add Swimlane" }));
    expect(onAdd).toHaveBeenCalled();
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

  it("submits name, description, and a picked due date", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();
    await user.type(screen.getByLabelText("Name"), "Sprint 9");
    await user.type(screen.getByLabelText(/Description/), "Release track");
    // due date via the embedded DatePicker (second picker = Due date)
    const duePicker = screen.getAllByRole("button", { name: "No due date" })[1]!;
    await user.click(duePicker);
    const day = (await screen.findAllByRole("button", { name: "15" }))[0]!;
    await user.click(day);
    await user.click(screen.getByRole("button", { name: "Create Swimlane" }));
    expect(onSubmit).toHaveBeenCalledWith({
      name: "Sprint 9",
      description: "Release track",
      dueAt: expect.stringMatching(/^\d{4}-\d{2}-15$/) as never,
      startAt: null,
      milestoneId: null,
    });
  });

  it("edit mode seeds fields; the Backlog lane hides the date/milestone fields", () => {
    renderForm({ swimlane: LANE });
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Backlog");
    expect(screen.queryByText(/Due date/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Start date/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Milestone/)).not.toBeInTheDocument();
  });

  it("milestone edit shows the seeded due date", () => {
    renderForm({ swimlane: MILESTONE });
    expect(screen.getByRole("button", { name: /2026-09-01/ })).toBeInTheDocument();
  });

  it("Delete Swimlane requires window.confirm", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { onClose } = renderForm({ swimlane: MILESTONE });
    await user.click(screen.getByRole("button", { name: "Delete Swimlane" }));
    expect(confirmSpy).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    confirmSpy.mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "Delete Swimlane" }));
    expect(onClose).toHaveBeenCalled();
    confirmSpy.mockRestore();
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
    expect(screen.getByText("Swimlanes")).toBeInTheDocument();
    // both add buttons singularize correctly
    expect(screen.getByRole("button", { name: "Add Priority" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Type" })).toBeInTheDocument();
  });

  it("adding a priority via the modal runs the PUT field-config mutation and syncs caches", async () => {
    const user = userEvent.setup();
    const newConfig = {
      priorities: [PRIORITY, { id: "", label: "Blocker", color: "#FF4444" }],
      types: [TYPE],
    };
    routes.set("PUT /api/projects/demo/field-config", {
      priorities: [PRIORITY, { id: "pr-blk", label: "Blocker", color: "#FF4444", position: 1 }],
      types: [TYPE],
    });
    queryClient.setQueryData(["field-config", "demo"], { priorities: [PRIORITY], types: [TYPE] });
    queryClient.setQueryData(["board", "demo", false], {
      project: { id: "p1", slug: "demo", name: "Demo", description: "", repos: [], createdAt: "t", updatedAt: "t" },
      columns: [COLUMN], swimlanes: [LANE],
      fieldConfig: { priorities: [PRIORITY], types: [TYPE] }, links: [], tasks: [],
    });
    render(<KanbanSettingsModal slug="demo" isOpen onClose={() => {}} />, { wrapper });
    await screen.findByText("Board Settings");

    await user.click(await screen.findByRole("button", { name: "Add Priority" }));
    await user.type(await screen.findByLabelText("Label"), "Blocker");
    // once the form opens, BOTH the section button and the form submit read
    // "Add Priority" — submit within the dialog
    // the OptionForm dialog is aria-labelledby "Add Priority" (the h2)
    const formDialog = screen.getByRole("dialog", { name: "Add Priority" });
    await user.click(within(formDialog).getByRole("button", { name: "Add Priority" }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("/field-config") && (c[1] as RequestInit | undefined)?.method === "PUT")).toHaveLength(1);
    });
    // invariant 6: caches updated via setQueryData from the response, no refetch
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("/field-config") && !(c[1] as RequestInit | undefined)?.method)).toHaveLength(1); // only the initial GET
    const config = queryClient.getQueryData<{ priorities: FieldOption[] }>(["field-config", "demo"])!;
    expect(config.priorities.map((p) => p.label)).toEqual(["High", "Blocker"]);
    const board = queryClient.getQueryData<{ fieldConfig: { priorities: FieldOption[] } }>(["board", "demo", false])!;
    expect(board.fieldConfig.priorities.map((p) => p.label)).toEqual(["High", "Blocker"]);
  });

  it("adding a column via the modal POSTs and updates the columns cache", async () => {
    const user = userEvent.setup();
    const newColumn: Column = { id: "c9", projectId: "p1", name: "Review", position: 2, color: "#22c55e", wipLimit: null, requiredFields: [], githubState: null, isDone: false };
    routes.set("POST /api/projects/demo/columns", newColumn);
    queryClient.setQueryData(["projects", "demo", "columns"], [COLUMN]);
    render(<KanbanSettingsModal slug="demo" isOpen onClose={() => {}} />, { wrapper });
    await screen.findByText("Board Settings");

    await user.click(await screen.findByRole("button", { name: "Add Column" }));
    await user.type(await screen.findByLabelText("Name"), "Review");
    await user.click(screen.getByRole("button", { name: /Create Column/ }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("/columns") && (c[1] as RequestInit | undefined)?.method === "POST")).toHaveLength(1);
    });
    const list = queryClient.getQueryData<Column[]>(["projects", "demo", "columns"])!;
    expect(list.map((c) => c.name)).toEqual(["Todo", "Review"]);
  });
});
