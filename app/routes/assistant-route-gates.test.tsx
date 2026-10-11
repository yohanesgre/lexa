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
  lastOptions: undefined as { enabled?: boolean } | undefined,
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useParams: () => ({ slug: "demo" }),
    useSearch: () => ({}),
  }),
  useNavigate: () => h.navigate,
}));

// Backs the real `useAssistantEnabled` gate (ADR-0003 §F.3): the routes and the
// hook read the same capability source.
vi.mock("../lib/queries", () => ({
  useProjects: () => ({ data: [{ id: "p1", slug: "demo", name: "Demo" }] }),
  useCapabilities: (opts?: { enabled?: boolean }) => {
    h.lastOptions = opts;
    return {
      data: h.loading ? undefined : { assistant: h.enabled, flavor: h.enabled ? "workers" : "bun" },
      isLoading: h.loading,
    };
  },
}));

vi.mock("../lib/project-selection", () => ({
  useProjectSelection: () => h.selection,
}));

vi.mock("../components/chat/AssistantChatPage", () => ({
  AssistantChatPage: () => <div data-testid="assistant-chat-page" />,
}));

import { renderHook } from "@testing-library/react";
import { useAssistantEnabled } from "../lib/assistant-enabled";

const { Route: chatRoute } = await import("./$slug/chat");
const { Route: bareChatRoute } = await import("./chat");

const ChatRoute = (chatRoute as unknown as { component: () => React.ReactElement }).component;
const BareChatRedirect = (bareChatRoute as unknown as { component: () => React.ReactElement }).component;

beforeEach(() => {
  h.enabled = true;
  h.loading = false;
  h.navigate.mockReset();
  h.selection = { selectedSlug: undefined };
  h.lastOptions = undefined;
});

describe("/$slug/chat capability gate", () => {
  it("renders the chat page when the assistant is enabled", () => {
    render(<ChatRoute />);
    expect(screen.getByTestId("assistant-chat-page")).toBeInTheDocument();
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

// Merged from lib/assistant-enabled.test.tsx — the hook itself is the single
// capability gate the UI reads: `enabled` is strictly true only once
// `GET /api/capabilities` resolves with `assistant:true`.
describe("useAssistantEnabled — capability gate", () => {
  it("is enabled on the Workers flavor and disabled on the Bun flavor", () => {
    h.enabled = true;
    const workers = renderHook(() => useAssistantEnabled());
    expect(workers.result.current).toEqual({ enabled: true, loading: false, flavor: "workers" });

    h.enabled = false;
    const bun = renderHook(() => useAssistantEnabled());
    expect(bun.result.current).toEqual({ enabled: false, loading: false, flavor: "bun" });
  });

  it("stays gated while the capabilities read is in flight or has not resolved", () => {
    h.loading = true;
    const inFlight = renderHook(() => useAssistantEnabled());
    expect(inFlight.result.current).toEqual({ enabled: false, loading: true, flavor: undefined });

    h.loading = false;
    h.enabled = false;
    const unresolved = renderHook(() => useAssistantEnabled());
    expect(unresolved.result.current.enabled).toBe(false);
  });

  it("forwards the enabled option to suppress the read on bare pages", () => {
    renderHook(() => useAssistantEnabled({ enabled: false }));
    expect(h.lastOptions).toEqual({ enabled: false });
  });
});
