// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { WikiPageMeta } from "../../../shared/types";

const mutateAsync = vi.hoisted(() => vi.fn());

vi.mock("../../lib/queries", () => ({
  useUpdateWikiPage: () => ({ mutateAsync, isPending: false }),
}));

import { MovePageModal, WikiPageContextMenu } from "./WikiPageContextMenu";

function meta(id: string, title: string, parentId: string | null, position = 0): WikiPageMeta {
  return { id, projectId: "p1", title, slug: title.toLowerCase().replace(/\s+/g, "-"), parentId, position, updatedAt: "2026-08-20T10:00:00.000Z" };
}

const root = meta("w1", "Root", null);
const child = meta("w2", "Child", "w1");
const grand = meta("w3", "Grand", "w2");
const other = meta("w4", "Other", null, 1);
const pages = [root, child, grand, other];

describe("WikiPageContextMenu", () => {
  it("enables Move and invokes onMove", () => {
    const onMove = vi.fn();
    render(
      <WikiPageContextMenu x={10} y={10} onAddChild={vi.fn()} onRename={vi.fn()} onMove={onMove} onDelete={vi.fn()} />
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
