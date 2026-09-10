// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { HearthTask, Runtime } from "../../../shared/types";
import { TaskBrief, runLabel } from "./HearthTaskStatusPanel";

const RUN: HearthTask = {
  id: "ht1",
  runtimeId: "rt1",
  projectId: "p1",
  documentType: "task",
  documentId: "t1",
  key: "EG-18",
  documentTitle: "Crash on large board load",
  agentId: "ag1",
  skillId: "sk1",
  agentName: "Herald Agent",
  skillName: "Requirements",
  extraPrompt: "",
  selection: "",
  docContext: "",
  status: "completed",
  result: null,
  error: null,
  kind: "herald",
  createdAt: "2026-01-01T12:04:10Z",
  startedAt: "2026-01-01T12:04:11Z",
  finishedAt: "2026-01-01T12:04:36Z",
};

const RUNTIME: Runtime = {
  id: "rt1",
  name: "dev-mbp",
  provider: "command-code",
  machineId: null,
  agent: "",
  model: "",
  printLogs: false,
  logLevel: "",
  extraArgs: [],
  modelsCatalog: [],
  agentsCatalog: [],
  status: "online",
  lastError: null,
  hostname: "dev-mbp",
  lastSeen: null,
  createdAt: "2026-01-01T00:00:00Z",
};

describe("TaskBrief", () => {
  it("renders the status lifecycle with created/started/finished timestamps", () => {
    render(<TaskBrief taskData={RUN} />);

    expect(screen.getByText("Queued")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();

    const stamps = screen.getAllByText(/^\d{2}:\d{2}:\d{2}$/);
    expect(stamps).toHaveLength(3);
  });

  it("renders a terminal status without a startedAt", () => {
    render(
      <TaskBrief
        taskData={{ ...RUN, status: "cancelled", startedAt: null, finishedAt: "2026-01-01T09:12:44Z" }}
      />
    );

    expect(screen.getByText("Queued")).toBeInTheDocument();
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
    expect(screen.queryByText("Running")).not.toBeInTheDocument();
    expect(screen.getAllByText(/^\d{2}:\d{2}:\d{2}$/)).toHaveLength(2);
  });
});

describe("runLabel", () => {
  it("renders runtime · provider · skill once a runtime has claimed the task", () => {
    expect(runLabel(RUN, [RUNTIME])).toBe("dev-mbp · command-code · Requirements");
  });

  it("falls back to Queued… before a runtime claims the task", () => {
    expect(runLabel({ ...RUN, runtimeId: null }, [RUNTIME])).toBe("Queued…");
  });
});
