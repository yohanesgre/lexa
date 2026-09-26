// @vitest-environment jsdom
// /admin/assistant — the superadmin shell: tab bar + <Outlet/>. Members are
// redirected away; the shell chrome never renders for them.
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: unknown) => ({ ...(opts as object), useSearch: () => ({}) }),
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>{children}</a>
  ),
  Navigate: () => <div data-testid="navigate-away" />,
  Outlet: () => <div data-testid="outlet" />,
  useRouterState: () => h.pathname,
}));

const h = vi.hoisted(() => ({ role: undefined as string | undefined, isLoading: false, pathname: "/admin/assistant" }));

vi.mock("../lib/queries", () => ({
  useSession: () => ({ data: h.role ? { user: { role: h.role } } : null, isLoading: h.isLoading }),
}));

vi.mock("../components/ui/Toast", () => ({ useToast: () => ({ push: vi.fn() }) }));

import { AssistantShell } from "./admin.assistant";

beforeEach(() => {
  h.role = undefined;
  h.isLoading = false;
  h.pathname = "/admin/assistant";
});

describe("admin.assistant shell gating", () => {
  it("renders the tab bar and the outlet for a superadmin", () => {
    h.role = "superadmin";
    render(<AssistantShell />);
    expect(screen.getByText("Assistant")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute("href", "/admin/assistant");
    expect(screen.getByRole("link", { name: "Providers & Models" })).toHaveAttribute("href", "/admin/assistant/providers");
    expect(screen.getByRole("link", { name: "Agents & Skills" })).toHaveAttribute("href", "/admin/assistant/agents");
    expect(screen.getByRole("link", { name: "Usage & Costs" })).toHaveAttribute("href", "/admin/assistant/usage");
    expect(screen.getByRole("link", { name: "Recent runs" })).toHaveAttribute("href", "/admin/assistant/runs");
    expect(screen.getByRole("link", { name: "Project bindings" })).toHaveAttribute("href", "/admin/assistant/bindings");
    expect(screen.getByTestId("outlet")).toBeInTheDocument();
    expect(screen.queryByTestId("navigate-away")).not.toBeInTheDocument();
  });

  it("marks the Overview tab active on the index path", () => {
    h.role = "superadmin";
    render(<AssistantShell />);
    expect(screen.getByRole("link", { name: "Overview" }).className).toContain("active");
  });

  it("marks the Overview tab active on the trailing-slash index path", () => {
    h.role = "superadmin";
    h.pathname = "/admin/assistant/";
    render(<AssistantShell />);
    expect(screen.getByRole("link", { name: "Overview" }).className).toContain("active");
  });

  it("highlights only the matching child tab on a child path", () => {
    h.role = "superadmin";
    h.pathname = "/admin/assistant/providers";
    render(<AssistantShell />);
    expect(screen.getByRole("link", { name: "Overview" }).className).not.toContain("active");
    expect(screen.getByRole("link", { name: "Providers & Models" }).className).toContain("active");
    expect(screen.getByRole("link", { name: "Agents & Skills" }).className).not.toContain("active");
    expect(screen.getByRole("link", { name: "Usage & Costs" }).className).not.toContain("active");
    expect(screen.getByRole("link", { name: "Recent runs" }).className).not.toContain("active");
    expect(screen.getByRole("link", { name: "Project bindings" }).className).not.toContain("active");
  });

  it("redirects members away from the shell", () => {
    h.role = "member";
    render(<AssistantShell />);
    expect(screen.getByTestId("navigate-away")).toBeInTheDocument();
    expect(screen.queryByTestId("outlet")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Overview" })).not.toBeInTheDocument();
  });

  it("renders nothing while the session is loading", () => {
    h.isLoading = true;
    const { container } = render(<AssistantShell />);
    expect(container).toBeEmptyDOMElement();
  });
});
