// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { WikiPageMeta } from "../../../shared/types";

const mutateAsync = vi.hoisted(() => vi.fn());

vi.mock("../../lib/queries", () => ({
  useUpdateWikiPage: () => ({ mutateAsync, isPending: false }),
}));

import { MovePageModal, WikiPageContextMenu } from "./WikiPageContextMenu";

function meta(id: string, title: string, parentId: string | null, position = 0): WikiPageMeta {
  return { id, projectId: "p1", title, slug: title.toLowerCase().replace(/\s+/g, "-"), parentId, position, updatedBy: null, updatedByName: null, updatedAt: "2026-08-20T10:00:00.000Z" };
}

const root = meta("w1", "Root", null);
const child = meta("w2", "Child", "w1");
const grand = meta("w3", "Grand", "w2");
const other = meta("w4", "Other", null, 1);
const pages = [root, child, grand, other];

function renderMenu(anchor = { top: 0, left: 0 }) {
  return render(
    <WikiPageContextMenu
      anchor={anchor}
      onAddChild={vi.fn()}
      onRename={vi.fn()}
      onMove={vi.fn()}
      onDelete={vi.fn()}
    />
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WikiPageContextMenu", () => {
  it("anchors below the row, exposes menu semantics, and focuses the first item", () => {
    renderMenu({ top: 100, left: 40 });
    const menu = screen.getByRole("menu", { name: "Page actions" });
    expect(menu).toHaveStyle({ position: "fixed", left: "40px", top: "100px" });
    const items = screen.getAllByRole("menuitem");
    expect(items).toHaveLength(4);
    expect(document.activeElement).toBe(items[0]);
  });

  it("moves focus with ArrowUp/ArrowDown and Home/End", () => {
    renderMenu();
    const items = screen.getAllByRole("menuitem");
    fireEvent.keyDown(items[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[3]);
    fireEvent.keyDown(items[3]!, { key: "Home" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0]!, { key: "End" });
    expect(document.activeElement).toBe(items[3]);
  });

  it("clamps the position to the viewport", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      top: 0,
      left: 0,
      right: 200,
      bottom: 100,
      width: 200,
      height: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    renderMenu({ top: 2000, left: 2000 });
    // jsdom viewport is 1024x768: left = 1024 - 200 - 8, top = 768 - 100 - 8.
    expect(screen.getByRole("menu")).toHaveStyle({ left: "816px", top: "660px" });
  });

  it("enables Move and invokes onMove", () => {
    const onMove = vi.fn();
    render(
      <WikiPageContextMenu anchor={{ top: 0, left: 0 }} onAddChild={vi.fn()} onRename={vi.fn()} onMove={onMove} onDelete={vi.fn()} />
    );
    const move = screen.getByRole("menuitem", { name: "Move" });
    expect(move).not.toBeDisabled();
    fireEvent.click(move);
    expect(onMove).toHaveBeenCalledTimes(1);
  });
});

describe("MovePageModal", () => {
  it("excludes the moved page and its descendants from the parent options", () => {
    render(<MovePageModal slug="demo" isOpen page={child} pages={pages} onClose={vi.fn()} />);
    const options = Array.from(screen.getByLabelText("Parent").querySelectorAll("option")).map((o) => o.textContent?.trim());
    expect(options).not.toContain("Child");
    expect(options).not.toContain("Grand");
    expect(options).toContain("Root");
    expect(options).toContain("Other");
  });

  it("reparents via the update endpoint on submit", async () => {
    mutateAsync.mockResolvedValue(child);
    const onClose = vi.fn();
    render(<MovePageModal slug="demo" isOpen page={child} pages={pages} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText("Parent"), { target: { value: "w4" } });
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith({ pageSlug: "child", parentId: "w4" });
    });
    expect(onClose).toHaveBeenCalled();
  });
});
