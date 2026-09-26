// @vitest-environment jsdom
// Wireframe design-system.html → user menu: role-scoped entries. "Assistant"
// (→ /admin/assistant) is superadmin-only, right after Workspace settings;
// team admin + member never see it.
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
}));

const h = vi.hoisted(() => ({
  role: "superadmin" as string,
  teams: [] as unknown[],
}));

vi.mock("../../lib/queries", () => ({
  useSession: () => ({
    data: { user: { name: "Alex", email: "alex@example.com", role: h.role } },
    isLoading: false,
  }),
  useTeams: () => ({ data: h.teams }),
  useSignOut: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { UserMenu } from "./UserMenu";

beforeEach(() => {
  h.role = "superadmin";
  h.teams = [];
});

async function openMenu() {
  const user = userEvent.setup();
  render(<UserMenu />);
  await user.click(screen.getByRole("button", { name: /Alex/ }));
}

describe("UserMenu role scoping", () => {
  it("shows Assistant to a superadmin, linked to /admin/assistant", async () => {
    await openMenu();
    const item = screen.getByText("Assistant").closest("a");
    expect(item).toHaveAttribute("href", "/admin/assistant");
    expect(screen.getByText("Workspace settings")).toBeInTheDocument();
  });

  it("hides Assistant from a team admin", async () => {
    h.role = "member";
    h.teams = [{ id: "t1" }];
    await openMenu();
    expect(screen.queryByText("Assistant")).not.toBeInTheDocument();
    expect(screen.getByText("Team settings")).toBeInTheDocument();
  });

  it("hides Assistant from a plain member", async () => {
    h.role = "member";
    h.teams = [];
    await openMenu();
    expect(screen.queryByText("Assistant")).not.toBeInTheDocument();
    expect(screen.getByText("User settings")).toBeInTheDocument();
    expect(screen.getByText("Log out")).toBeInTheDocument();
  });
});
