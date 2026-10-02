// @vitest-environment jsdom
// Wireframes src/wiki-shared.html:24-27 — peer-toggle convention: the accessible
// name is constant (`aria-label="Theme"`), `aria-pressed` reflects the LIGHT
// theme being active, the state-varying `title` is only an action hint, and the
// icon reflects the current state (dark active → Moon, light active → Sun).
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  theme: "dark" as "dark" | "light",
  mounted: true,
  toggle: vi.fn(),
}));

vi.mock("../../lib/theme", () => ({
  useTheme: () => ({ theme: h.theme, toggleTheme: h.toggle, mounted: h.mounted }),
}));

import { ThemeToggle } from "./ThemeToggle";

beforeEach(() => {
  h.theme = "dark";
  h.mounted = true;
  h.toggle.mockClear();
});

describe("ThemeToggle", () => {
  it("keeps the accessible name constant across both states", () => {
    const { container, rerender } = render(<ThemeToggle />);
    expect(screen.getByRole("button", { name: "Theme" })).toBeInTheDocument();
    h.theme = "light";
    rerender(<ThemeToggle />);
    expect(screen.getByRole("button", { name: "Theme" })).toBeInTheDocument();
    expect(container.querySelectorAll(".nav-pill")).toHaveLength(1);
  });

  it("reflects the light theme via aria-pressed", () => {
    h.theme = "dark";
    const { rerender } = render(<ThemeToggle />);
    expect(screen.getByRole("button", { name: "Theme" })).toHaveAttribute("aria-pressed", "false");
    h.theme = "light";
    rerender(<ThemeToggle />);
    expect(screen.getByRole("button", { name: "Theme" })).toHaveAttribute("aria-pressed", "true");
  });

  it("renders the current-state icon", () => {
    h.theme = "dark";
    const { container, rerender } = render(<ThemeToggle />);
    expect(container.querySelector(".lucide-moon")).toBeInTheDocument();
    expect(container.querySelector(".lucide-sun")).not.toBeInTheDocument();
    h.theme = "light";
    rerender(<ThemeToggle />);
    expect(container.querySelector(".lucide-sun")).toBeInTheDocument();
    expect(container.querySelector(".lucide-moon")).not.toBeInTheDocument();
  });

  it("defaults to the dark-theme moon and aria-pressed=false before mount", () => {
    h.mounted = false;
    const { container } = render(<ThemeToggle />);
    expect(screen.getByRole("button", { name: "Theme" })).toHaveAttribute("aria-pressed", "false");
    expect(container.querySelector(".lucide-moon")).toBeInTheDocument();
    expect(container.querySelector(".lucide-sun")).not.toBeInTheDocument();
  });

  it("varies title as an action hint, never the name", () => {
    h.theme = "dark";
    const { rerender } = render(<ThemeToggle />);
    expect(screen.getByRole("button", { name: "Theme" })).toHaveAttribute("title", "Light theme");
    h.theme = "light";
    rerender(<ThemeToggle />);
    expect(screen.getByRole("button", { name: "Theme" })).toHaveAttribute("title", "Dark theme");
  });
});
