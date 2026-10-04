// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("../../../lib/queries/assistant-admin", () => ({
  useAssistantCalls: () => ({
    data: [
      { id: "c1", model: "gpt-5.1", status: "done", latencyMs: 120, usageIn: 10, usageOut: 20, costCents: 4, errorCode: null, createdAt: "2026-08-27 14:22:11" },
      { id: "c2", model: "gpt-5.1", status: "error", latencyMs: 80, usageIn: 0, usageOut: 0, costCents: 0, errorCode: "PROVIDER_UNREACHABLE", createdAt: "2026-08-27 14:23:11" },
      { id: "c3", model: "gpt-5.1", status: "suspended", latencyMs: 40, usageIn: 5, usageOut: 5, costCents: 1, errorCode: "RATE_LIMITED", createdAt: "2026-08-27 14:24:11" },
      { id: "c4", model: "gpt-5.1", status: "aborted", latencyMs: null, usageIn: 0, usageOut: 0, costCents: 0, errorCode: null, createdAt: "2026-08-27 14:25:11" },
    ],
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));

import { AssistantCallsTable } from "./AssistantCallsTable";

describe("AssistantCallsTable", () => {
  it("gives suspended and aborted their own status chips instead of collapsing to error", () => {
    render(<AssistantCallsTable />);
    expect(screen.getByText("Ok")).toBeInTheDocument();
    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(screen.getByText("Suspended")).toBeInTheDocument();
    expect(screen.getByText("Aborted")).toBeInTheDocument();
  });
});
