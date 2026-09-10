// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { SlideoverHeader } from "./SlideoverHeader";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, className }: { children: ReactNode; className?: string }) => <a className={className}>{children}</a>,
}));

describe("SlideoverHeader", () => {
  it("opens the full page through the expand button", () => {
    const onExpand = vi.fn();
    render(
      <SlideoverHeader
        slug="demo"
        project={{ name: "Demo" }}
        isCreate={false}
        onExpand={onExpand}
        onClose={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open full page" }));
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it("hides expand in create mode", () => {
    render(
      <SlideoverHeader
        slug="demo"
        project={{ name: "Demo" }}
        isCreate
        onExpand={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.queryByRole("button", { name: "Open full page" })).not.toBeInTheDocument();
  });
});
