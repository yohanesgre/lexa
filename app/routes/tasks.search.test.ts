// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";

// createFileRoute passes its options straight through under this mock, so
// the real validateSearch implementation runs without a router context.
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => options,
}));

const { Route } = await import("./$slug/tasks");
const validateSearch = (Route as unknown as { validateSearch: (s: Record<string, unknown>) => { new?: boolean; task?: string; swimlane?: string } }).validateSearch;

describe("/$slug/tasks search params", () => {
  it("opens create for the number form the router parser produces from ?new=1", () => {
    expect(validateSearch({ new: 1 })).toEqual({ new: true });
  });

  it("still accepts the string and boolean forms", () => {
    expect(validateSearch({ new: "1" })).toEqual({ new: true });
    expect(validateSearch({ new: true })).toEqual({ new: true });
  });

  it("drops other new values and passes task/swimlane strings through", () => {
    expect(validateSearch({ new: "0" })).toEqual({ new: undefined });
    expect(validateSearch({ new: 0 })).toEqual({ new: undefined });
    expect(validateSearch({ task: "t1", swimlane: "s2" })).toEqual({ task: "t1", swimlane: "s2", new: undefined });
  });
});
