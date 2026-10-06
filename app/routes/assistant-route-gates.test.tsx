// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// ADR-0003 §F.3 — the chat routes are capability-gated: on the Bun flavor a
// direct URL renders the unavailable notice instead of the surface (or a
// redirect into a surface that does not exist).

const h = vi.hoisted(() => ({
  enabled: true,
  loading: false,
  navigate: vi.fn(),
  selection: { selectedSlug: undefined as string | undefined },
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useParams: () => ({ slug: "demo" }),
    useSearch: () => ({}),
  }),
  useNavigate: () => h.navigate,
}));

vi.mock("../lib/assistant-enabled", () => ({
  useAssistantEnabled: () => ({ enabled: h.enabled, loading: h.loading, flavor: h.enabled ? "workers" : "bun" }),
}));

vi.mock("../lib/queries", () => ({
  useProjects: () => ({ data: [{ id: "p1", slug: "demo", name: "Demo" }] }),
}));

vi.mock("../lib/project-selection", () => ({
  useProjectSelection: () => h.selection,
}));

vi.mock("../components/chat/AssistantChatPage", () => ({
  AssistantChatPage: () => <div data-testid="assistant-chat-page" />,
}));

const { Route: chatRoute } = await import("./$slug/chat");
const { Route: bareChatRoute } = await import("./chat");

const ChatRoute = (chatRoute as unknown as { component: () => React.ReactElement }).component;
const BareChatRedirect = (bareChatRoute as unknown as { component: () => React.ReactElement }).component;

beforeEach(() => {
  h.enabled = true;
  h.loading = false;
  h.navigate.mockReset();
  h.selection = { selectedSlug: undefined };
});

describe("/$slug/chat capability gate", () => {
  it("renders the chat page when the assistant is enabled", async () => {
    render(<ChatRoute />);
    expect(await screen.findByTestId("assistant-chat-page")).toBeInTheDocument();
    expect(screen.queryByText("The Assistant runs on the Cloudflare Workers deployment")).not.toBeInTheDocument();
  });

  it("renders the notice instead of the surface when disabled", () => {
    h.enabled = false;
    render(<ChatRoute />);
    expect(screen.getByText("The Assistant runs on the Cloudflare Workers deployment")).toBeInTheDocument();
    expect(screen.queryByTestId("assistant-chat-page")).not.toBeInTheDocument();
  });

  it("renders nothing while capabilities resolve", () => {
    h.loading = true;
    const { container } = render(<ChatRoute />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("/chat bare redirect capability gate", () => {
  it("redirects to the project chat when enabled", () => {
    h.selection = { selectedSlug: "demo" };
    const { container } = render(<BareChatRedirect />);
    expect(container).toBeEmptyDOMElement();
    expect(h.navigate).toHaveBeenCalledWith({ to: "/$slug/chat", params: { slug: "demo" }, replace: true });
  });

  it("renders the notice and never redirects when disabled", () => {
    h.enabled = false;
    h.selection = { selectedSlug: "demo" };
    render(<BareChatRedirect />);
    expect(screen.getByText("The Assistant runs on the Cloudflare Workers deployment")).toBeInTheDocument();
    expect(h.navigate).not.toHaveBeenCalled();
  });
});
