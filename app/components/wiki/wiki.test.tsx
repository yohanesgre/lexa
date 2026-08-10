// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { WikiSidebar } from "./WikiSidebar";
import { OutlineSidebar } from "./OutlineSidebar";
import { WikiEmptyState } from "./WikiEmptyState";
import { NewPageModal } from "./NewPageModal";
import type { WikiPageMeta } from "../../../shared/types";

// OutlineSidebar observes heading elements via IntersectionObserver — jsdom
// does not implement it, so stub a minimal one.
class IntersectionObserverStub {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  root = null;
  rootMargin = "";
  thresholds = [];
  takeRecords = () => [];
}
(globalThis as Record<string, unknown>).IntersectionObserver = IntersectionObserverStub;

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));

const PAGES: WikiPageMeta[] = [
  { id: "w1", projectId: "p1", title: "Home", slug: "home", parentId: null, position: 0, updatedAt: "t" },
  { id: "w2", projectId: "p1", title: "Guide", slug: "guide", parentId: null, position: 1, updatedAt: "t" },
  { id: "w3", projectId: "p1", title: "Combat", slug: "combat", parentId: "w2", position: 0, updatedAt: "t" },
];

describe("WikiSidebar", () => {
  it("renders the title and children in expanded mode", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<WikiSidebar title="Contents" collapsed={false} onToggle={onToggle}>body</WikiSidebar>);
    expect(screen.getByText("Contents")).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("collapsed mode shows only the expand button", async () => {
    render(<WikiSidebar title="Contents" collapsed onToggle={() => {}}>body</WikiSidebar>);
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
    expect(screen.queryByText("Contents")).not.toBeInTheDocument();
  });
});

describe("OutlineSidebar", () => {
  it("builds a nested tree; children render expanded on first mount (wireframe default)", () => {
    // Fixed: expandedKeys lazy-inits from the tree, so mount behaves exactly
    // like updates — nested headings are visible by default, matching the
    // wireframe outline (wireframes/src/wiki.html renders all levels expanded).
    const headings = [
      { id: "h1", text: "Intro", level: 1 },
      { id: "h2", text: "Sub", level: 2 },
      { id: "h3", text: "Deeper", level: 3 },
    ];
    render(<OutlineSidebar headings={headings} />);
    expect(screen.getByText("Intro")).toBeInTheDocument();
    expect(screen.getByText("Sub")).toBeInTheDocument();
    expect(screen.getByText("Deeper")).toBeInTheDocument();
  });

  it("collapses an expanded section via the toggle and expands it again", async () => {
    const user = userEvent.setup();
    const headings = [
      { id: "h1", text: "Intro", level: 1 },
      { id: "h2", text: "Sub", level: 2 },
    ];
    render(<OutlineSidebar headings={headings} />);
    // expanded by default (wireframe default, fixed)
    expect(screen.getByText("Sub")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Toggle section" }));
    expect(screen.queryByText("Sub")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Toggle section" }));
    expect(screen.getByText("Sub")).toBeInTheDocument();
  });

  it("returns null without headings", () => {
    render(<OutlineSidebar headings={[]} />);
    expect(screen.queryByText("Contents")).not.toBeInTheDocument();
  });
});

describe("WikiEmptyState", () => {
  it("renders the copy and fires onCreate", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<WikiEmptyState onCreate={onCreate} />);
    expect(screen.getByText("No pages yet")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create the first page" }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });
});

describe("NewPageModal", () => {
  const fetchMock = vi.fn();
  const routes = new Map<string, unknown>();
  let queryClient: QueryClient;

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    routes.clear();
    routes.set("POST /api/projects/demo/wiki", { ...PAGES[0], id: "w9", slug: "new-page", title: "New Page" });
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const key = `${init?.method ?? "GET"} ${url}`;
      const hit = routes.get(key) ?? routes.get(`GET ${url}`);
      if (hit === undefined) return Promise.reject(new Error(`unmocked: ${key}`));
      if (hit === 204) return Promise.resolve(new Response(null, { status: 204 }));
      return Promise.resolve(json(hit));
    });
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    queryClient.clear();
  });

  function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }

  it("rejects an empty title", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<NewPageModal slug="demo" isOpen onClose={onClose} pages={PAGES} />, { wrapper });
    await user.click(screen.getByRole("button", { name: "Create page" }));
    expect(screen.getByText("Title is required")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("lists pages in a parent select (nested with depth) and creates under the chosen parent", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    queryClient.setQueryData(["wiki", "demo"], PAGES);
    render(<NewPageModal slug="demo" isOpen onClose={onClose} pages={PAGES} />, { wrapper });
    const parent = screen.getByLabelText("Parent") as HTMLSelectElement;
    expect(Array.from(parent.options).map((o) => o.textContent?.trim())).toEqual([
      "(No parent — root)",
      "Home",
      "Guide",
      "Combat",
    ]);
    await user.type(screen.getByLabelText("Title"), "New Page");
    await user.selectOptions(parent, "w2");
    await user.click(screen.getByRole("button", { name: "Create page" }));
    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/wiki") && (c[1] as RequestInit | undefined)?.method === "POST");
      expect(posts).toHaveLength(1);
    });
    const post = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/wiki") && (c[1] as RequestInit | undefined)?.method === "POST")!;
    expect(JSON.parse((post[1] as RequestInit).body as string)).toEqual({ title: "New Page", parentId: "w2" });
    // invariant 6: the wiki list cache is updated from the response, no refetch
    const list = queryClient.getQueryData<WikiPageMeta[]>(["wiki", "demo"])!;
    expect(list.map((p) => p.slug)).toEqual(["home", "guide", "combat", "new-page"]);
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/wiki") && !(c[1] as RequestInit | undefined)?.method)).toHaveLength(0);
    expect(onClose).toHaveBeenCalled();
  });

  it("renders nothing when closed", () => {
    render(<NewPageModal slug="demo" isOpen={false} onClose={() => {}} pages={PAGES} />, { wrapper });
    expect(screen.queryByText("New page")).not.toBeInTheDocument();
  });
});
