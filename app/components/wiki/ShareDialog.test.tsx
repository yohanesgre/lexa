// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ShareDialog } from "./ShareDialog";
import type { WikiShareLink } from "../../lib/api";

vi.mock("../../lib/queries", () => ({
  useWikiShareLinks: vi.fn(),
  useCreateWikiShareLink: vi.fn(),
  useRevokeWikiShareLink: vi.fn(),
}));

import { useCreateWikiShareLink, useRevokeWikiShareLink, useWikiShareLinks } from "../../lib/queries";

const mockedLinks = vi.mocked(useWikiShareLinks);
const mockedCreate = vi.mocked(useCreateWikiShareLink);
const mockedRevoke = vi.mocked(useRevokeWikiShareLink);

const linkA: WikiShareLink = { id: "l1", url: "http://lexa.test/share/aaaa", expiresAt: "2026-09-30T00:00:00.000Z", createdAt: "2026-08-18T10:00:00.000Z" };
const linkB: WikiShareLink = { id: "l2", url: "http://lexa.test/share/bbbb", expiresAt: null, createdAt: "2026-08-20T10:00:00.000Z" };

function setupHooks() {
  const createMutateAsync = vi.fn().mockResolvedValue({ link: linkA });
  const revokeMutate = vi.fn();
  mockedLinks.mockReturnValue({ data: [linkA, linkB] } as ReturnType<typeof useWikiShareLinks>);
  mockedCreate.mockReturnValue({ mutateAsync: createMutateAsync, isPending: false } as unknown as ReturnType<typeof useCreateWikiShareLink>);
  mockedRevoke.mockReturnValue({ mutate: revokeMutate, isPending: false } as unknown as ReturnType<typeof useRevokeWikiShareLink>);
  return { createMutateAsync, revokeMutate };
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

describe("ShareDialog", () => {
  it("renders nothing when closed", () => {
    setupHooks();
    render(<ShareDialog slug="p1" pageSlug="home" isOpen={false} onClose={() => {}} />);
    expect(screen.queryByText("Share page")).toBeNull();
  });

  it("lists links with expiry badge and never-expires label", () => {
    setupHooks();
    render(<ShareDialog slug="p1" pageSlug="home" isOpen onClose={() => {}} />);
    expect(screen.getByText("http://lexa.test/share/aaaa")).toBeTruthy();
    expect(screen.getByText(/Expires Sep 30, 2026/)).toBeTruthy();
    expect(screen.getByText("Never expires")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Revoke" }).length).toBe(2);
  });

  it("copy writes the URL to the clipboard and flips feedback to Copied", async () => {
    setupHooks();
    render(<ShareDialog slug="p1" pageSlug="home" isOpen onClose={() => {}} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Copy" })[0]);
    await vi.waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("http://lexa.test/share/aaaa"));
    await vi.waitFor(() => expect(screen.getAllByText("Copied").length).toBeGreaterThan(0));
  });

  it("revoke calls the mutation with the link id (no confirm step)", () => {
    const { revokeMutate } = setupHooks();
    render(<ShareDialog slug="p1" pageSlug="home" isOpen onClose={() => {}} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Revoke" })[1]);
    expect(revokeMutate).toHaveBeenCalledWith("l2");
  });

  it("create calls the mutation with the picked expiry and auto-copies the new URL", async () => {
    const { createMutateAsync } = setupHooks();
    render(<ShareDialog slug="p1" pageSlug="home" isOpen onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Expiry date (optional)"), { target: { value: "2026-12-31" } });
    fireEvent.click(screen.getByRole("button", { name: /Create link/ }));
    await vi.waitFor(() => expect(createMutateAsync).toHaveBeenCalledWith("2026-12-31"));
    await vi.waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("http://lexa.test/share/aaaa"));
  });

  it("create with empty expiry passes undefined (never expires)", async () => {
    const { createMutateAsync } = setupHooks();
    render(<ShareDialog slug="p1" pageSlug="home" isOpen onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Create link/ }));
    await vi.waitFor(() => expect(createMutateAsync).toHaveBeenCalledWith(undefined));
  });

  it("close button invokes onClose", () => {
    setupHooks();
    const onClose = vi.fn();
    render(<ShareDialog slug="p1" pageSlug="home" isOpen onClose={onClose} />);
    const closeButtons = screen.getAllByRole("button", { name: "Close" });
    fireEvent.click(closeButtons[closeButtons.length - 1]);
    expect(onClose).toHaveBeenCalled();
  });
});
