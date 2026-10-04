// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import type { WikiPageMeta } from "../../../shared/types";

const createMock = vi.hoisted(() => ({ mutateAsync: vi.fn(), isPending: false }));
const updateMock = vi.hoisted(() => ({ mutateAsync: vi.fn(), isPending: false }));
const shareHooks = vi.hoisted(() => ({
  create: { mutateAsync: vi.fn(), isPending: false },
  revoke: { mutate: vi.fn(), isPending: false },
}));
const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigateMock }));
vi.mock("../../lib/queries", () => ({
  useCreateWikiPage: () => createMock,
  useUpdateWikiPage: () => updateMock,
  useWikiShareLinks: () => ({ data: [] }),
  useCreateWikiShareLink: () => shareHooks.create,
  useRevokeWikiShareLink: () => shareHooks.revoke,
}));

import { NewPageModal } from "./NewPageModal";
import { RenamePageModal } from "./RenamePageModal";
import { WikiDeletePageDialog } from "./WikiDeletePageDialog";
import { ShareDialog } from "./ShareDialog";

const parent: WikiPageMeta = {
  id: "p1",
  projectId: "proj",
  title: "Parent",
  slug: "parent",
  parentId: null,
  position: 0,
  updatedBy: null,
  updatedByName: null,
  updatedAt: "2026-08-20T10:00:00.000Z",
};

beforeEach(() => {
  createMock.mutateAsync.mockReset();
  updateMock.mutateAsync.mockReset();
  shareHooks.create.mutateAsync.mockReset();
  navigateMock.mockReset();
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NewPageModal", () => {
  it("seeds the parent from defaultParentId and creates the child under it", async () => {
    createMock.mutateAsync.mockResolvedValue({ ...parent, id: "c1", title: "Child", slug: "child", parentId: "p1" });
    render(<NewPageModal slug="demo" isOpen onClose={vi.fn()} defaultParentId="p1" pages={[parent]} />);

    expect((screen.getByLabelText("Parent") as HTMLSelectElement).value).toBe("p1");

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Child" } });
    fireEvent.click(screen.getByRole("button", { name: /Create page/ }));

    await waitFor(() =>
      expect(createMock.mutateAsync).toHaveBeenCalledWith({ title: "Child", parentId: "p1" })
    );
  });
});

describe("RenamePageModal", () => {
  it("prefills the current title", () => {
    render(<RenamePageModal slug="demo" page={parent} isOpen onClose={vi.fn()} />);
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Parent");
  });
});

describe("WikiDeletePageDialog focus contract", () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          open
        </button>
        {open && (
          <WikiDeletePageDialog
            page={parent}
            pending={false}
            hasChildren={false}
            onConfirm={vi.fn()}
            onCancel={() => setOpen(false)}
          />
        )}
      </>
    );
  }

  it("focuses inside, traps Tab, closes on Escape and returns focus to the row", async () => {
    render(<Harness />);
    const trigger = screen.getByText("open");
    act(() => trigger.focus());
    fireEvent.click(trigger);

    const dialog = document.querySelector("dialog")!;
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const confirm = screen.getByRole("button", { name: "Delete" });

    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(cancel);

    act(() => confirm.focus());
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(cancel);

    act(() => cancel.focus());
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(confirm);

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("blocks deletion and explains when the page has children", () => {
    render(
      <WikiDeletePageDialog page={parent} pending={false} hasChildren onConfirm={vi.fn()} onCancel={vi.fn()} />
    );
    expect(screen.getByText(/has child pages/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
  });

  it("renders the title as an h2 and a decorative trash icon on the confirm button", () => {
    render(
      <WikiDeletePageDialog page={parent} pending={false} hasChildren={false} onConfirm={vi.fn()} onCancel={vi.fn()} />
    );
    expect(screen.getByRole("heading", { level: 2, name: "Delete page" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" }).querySelector("svg")).not.toBeNull();
  });
});

describe("ShareDialog focus contract", () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          share
        </button>
        <ShareDialog slug="demo" pageSlug="parent" isOpen={open} onClose={() => setOpen(false)} />
      </>
    );
  }

  it("moves focus inside and returns it to the trigger on close", async () => {
    render(<Harness />);
    const trigger = screen.getByText("share");
    act(() => trigger.focus());
    fireEvent.click(trigger);

    const dialog = document.querySelector("dialog")!;
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("traps Tab across the dialog and into the portaled DatePicker calendar", () => {
    render(<Harness />);
    const trigger = screen.getByText("share");
    act(() => trigger.focus());
    fireEvent.click(trigger);

    const dialog = document.querySelector("dialog")!;
    const close = within(dialog).getByRole("button", { name: "Close" });
    const create = within(dialog).getByRole("button", { name: /Create link/ });

    act(() => create.focus());
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(close);

    act(() => close.focus());
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(create);

    // Open the DatePicker — its calendar portals to document.body.
    fireEvent.click(within(dialog).getByRole("button", { name: "No expiry" }));
    const popover = document.querySelector<HTMLElement>(".datepicker-popover");
    expect(popover).not.toBeNull();

    // Tab off the last dialog control enters the portaled calendar as a group.
    act(() => create.focus());
    fireEvent.keyDown(document, { key: "Tab" });
    expect(popover!.contains(document.activeElement)).toBe(true);

    // Shift+Tab off the first dialog control lands on the calendar's last item.
    act(() => close.focus());
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(popover!.contains(document.activeElement)).toBe(true);
  });

  it("wraps Tab from the portaled DatePicker popover back into the dialog", () => {
    render(<Harness />);
    const trigger = screen.getByText("share");
    act(() => trigger.focus());
    fireEvent.click(trigger);

    const dialog = document.querySelector("dialog")!;
    const close = within(dialog).getByRole("button", { name: "Close" });
    const create = within(dialog).getByRole("button", { name: /Create link/ });

    fireEvent.click(within(dialog).getByRole("button", { name: "No expiry" }));
    const popover = document.querySelector<HTMLElement>(".datepicker-popover")!;
    const popItems = Array.from(popover.querySelectorAll<HTMLElement>("button"));
    expect(popItems.length).toBeGreaterThan(0);

    // Tab off the calendar's last item wraps to the dialog's first control.
    act(() => popItems[popItems.length - 1]!.focus());
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(close);

    // Shift+Tab off the calendar's first item wraps to the dialog's last control.
    act(() => popItems[0]!.focus());
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(create);
  });

  it("lets Escape close the DatePicker popover before the dialog", async () => {
    render(<Harness />);
    const trigger = screen.getByText("share");
    act(() => trigger.focus());
    fireEvent.click(trigger);

    const dialog = document.querySelector("dialog")!;
    fireEvent.click(within(dialog).getByRole("button", { name: "No expiry" }));
    expect(document.querySelector(".datepicker-popover")).not.toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(document.querySelector(".datepicker-popover")).toBeNull());
    expect(screen.getByText("Share page")).toBeInTheDocument();
  });
});
