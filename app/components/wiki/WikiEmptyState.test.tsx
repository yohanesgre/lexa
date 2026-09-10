// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { WikiEmptyState } from "./WikiEmptyState";

describe("WikiEmptyState", () => {
  it("uses the wireframe copy (workflow formulas)", () => {
    render(<WikiEmptyState onCreate={vi.fn()} />);
    expect(
      screen.getByText(/design docs, workflow formulas, and art direction/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/combat formulas/)).toBeNull();
    expect(screen.getByRole("button", { name: /create the first page/i })).toBeInTheDocument();
  });
});
