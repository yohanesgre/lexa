// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";

// createFileRoute passes its options straight through under this mock, so
// the real validateSearch implementation runs without a router context.
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => options,
}));

const { Route } = await import("./$slug/chat");
const validateSearch = (Route as unknown as { validateSearch: (s: Record<string, unknown>) => { thread?: string } }).validateSearch;

describe("/$slug/chat search params", () => {
  it("passes a string thread param through", () => {
    expect(validateSearch({ thread: "abc-123" })).toEqual({ thread: "abc-123" });
  });

  it("drops non-string and missing thread params", () => {
    expect(validateSearch({})).toEqual({});
    expect(validateSearch({ thread: 42 })).toEqual({});
    expect(validateSearch({ thread: ["a"] })).toEqual({});
    expect(validateSearch({ other: "x" })).toEqual({});
  });
});
