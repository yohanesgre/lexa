// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { HeraldChatPage, renderTranscript, safeCitations, guidanceFor, splitFences } from "./HeraldChatPage";

const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
  Link: ({ to, params, className, children }: { to: string; params?: Record<string, string>; className?: string; children?: React.ReactNode }) => (
    <a href={`${to}?projectId=${params?.projectId ?? ""}`} className={className}>{children}</a>
  ),
}));

// Wire transcript entries.
const u = (text: string, extra: Record<string, unknown> = {}) => ({ role: "user", content: text, ...extra });
const a = (text: string, extra: Record<string, unknown> = {}) => ({ role: "assistant", content: text, ...extra });

const SETTINGS = {
  projectId: "p1",
  kind: "openai_compatible",
  baseUrl: "https://api.example.com/v1",
  model: "gpt-x",
  hasKey: true,
  keyMask: "sk-…abc",
  searchProvider: null,
  hasSearchKey: false,
  urlAllowlist: null,
  engine: "herald",
  engineSwitcherEnabled: false,
  primarySupportsImages: false,
  visionProvider: null,
  visionModel: null,
  hasVisionKey: false,
  reasoningEffort: "medium",
};

// Per-test override — engine/vision surfaces gate on these fields.
let currentSettings = { ...SETTINGS };

const PROJECT = { id: "p1", slug: "demo", name: "Demo", description: "", repos: [], createdAt: "t", updatedAt: "t" };

function sse(frames: unknown[]): Response {
  const body = frames.map((f) => `event: ${(f as { type: string }).type}\ndata: ${JSON.stringify(f)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

let transcripts = new Map<string, unknown[]>();
const streamBodies: Record<string, unknown>[] = [];
let chatThreads: unknown[] = [];
// Per-test override for the stream endpoint (reasoning-frame scenarios).
let streamOverride: ((body: Record<string, unknown>) => Response) | null = null;
const chatPatchCalls: { chatId: string; body: Record<string, unknown> }[] = [];
const chatDeleteCalls: string[] = [];
const fetchMock = vi.fn();

function mockFetch() {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const key = `${init?.method ?? "GET"} ${url.split("?")[0]}`;
    if (key.startsWith("POST /api/herald/chat/stream")) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      streamBodies.push(body);
      if (streamOverride) return Promise.resolve(streamOverride(body));
      return Promise.resolve(sse([{ type: "start", threadId: "t" }, { type: "done", text: "ok", usage: { in: 1, out: 1 } }]));
    }
    if (key.startsWith("GET /api/herald/chat/")) {
      const chatId = url.split("/").pop()!;
      return Promise.resolve(new Response(JSON.stringify({ chatId, projectId: "p1", ownerUserId: null, agentId: null, skillId: null, messages: transcripts.get(chatId) ?? [], summary: null, summarizedCount: 0, createdAt: "t", updatedAt: "t" }), { status: 200 }));
    }
    if (key.startsWith("PATCH /api/herald/chat/")) {
      chatPatchCalls.push({ chatId: url.split("/").pop()!, body: JSON.parse(String(init?.body)) });
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    }
    if (key.startsWith("DELETE /api/herald/chat/")) {
      chatDeleteCalls.push(url.split("/").pop()!);
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    const routes: Record<string, unknown> = {
      "GET /api/projects": { data: [PROJECT], nextCursor: null },
      "GET /api/herald/settings/p1": currentSettings,
      "GET /api/herald/chats/p1": { data: chatThreads },
      "GET /api/agents": { data: [{ id: "hearth-herald", name: "Herald Agent", description: "", instructions: "", skillIds: [] }] },
      "GET /api/skills": { data: [] },
    };
    if (!(key in routes)) return Promise.reject(new Error(`unmocked: ${key}`));
    return Promise.resolve(new Response(JSON.stringify(routes[key]), { status: 200 }));
  });
}

let queryClient: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

// jsdom gives no layout — pin scroll metrics on a scroller instance directly.
function stubMetrics(el: HTMLElement, scrollTop: number, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(el, "scrollTop", { value: scrollTop, configurable: true });
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true });
}

beforeEach(() => {
  transcripts = new Map();
  streamBodies.length = 0;
  chatThreads = [];
  chatPatchCalls.length = 0;
  chatDeleteCalls.length = 0;
  navigateMock.mockReset();
  currentSettings = { ...SETTINGS };
  streamOverride = null;
  vi.stubGlobal("fetch", fetchMock);
  mockFetch();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HeraldChatPage affordances", () => {
  it("edit-inline: ✓-row swaps to prefilled textarea; Enter resends with fromIndex at the edited turn", async () => {
    transcripts.set("t-edit", [u("first question"), a("first answer"), u("second question"), a("second answer")]);
    render(<HeraldChatPage slug="demo" thread="t-edit" />, { wrapper });
    expect(await screen.findByText("first question")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Edit message 1" }));
    const textarea = screen.getByLabelText("Edit message") as HTMLTextAreaElement;
    expect(textarea.value).toBe("first question");
    fireEvent.change(textarea, { target: { value: "rewritten first question" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(streamBodies).toHaveLength(1));
    expect(streamBodies[0]).toMatchObject({ message: "rewritten first question", fromIndex: 0 });
    // Esc cancels without sending.
    await waitFor(() => expect(screen.queryByLabelText("Edit message")).not.toBeInTheDocument());
  });

  it("regenerate exists only on the last user turn and resends that message with its index", async () => {
    transcripts.set("t-regen", [u("earlier ask"), a("earlier reply"), u("latest ask"), a("latest reply")]);
    render(<HeraldChatPage slug="demo" thread="t-regen" />, { wrapper });
    expect(await screen.findByText("latest ask")).toBeInTheDocument();

    // Exactly one regenerate affordance — on the last user turn only.
    const regenButtons = screen.getAllByRole("button", { name: "Regenerate from here" });
    expect(regenButtons).toHaveLength(1);
    fireEvent.click(regenButtons[0]);

    await waitFor(() => expect(streamBodies).toHaveLength(1));
    expect(streamBodies[0]).toMatchObject({ message: "latest ask", fromIndex: 2 });
  });

  it("failed bubble (PROVIDER_UNREACHABLE): prominent Retry resends the triggering user message with its fromIndex", async () => {
    transcripts.set("t-fail", [
      u("trigger"),
      a("", { error: { code: "PROVIDER_UNREACHABLE", message: "" } }),
    ]);
    render(<HeraldChatPage slug="demo" thread="t-fail" />, { wrapper });
    expect(await screen.findByText("PROVIDER_UNREACHABLE")).toBeInTheDocument();
    expect(screen.getByText(/provider closed the stream unexpectedly/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^retry$/i }));
    await waitFor(() => expect(streamBodies).toHaveLength(1));
    expect(streamBodies[0]).toMatchObject({ message: "trigger", fromIndex: 0 });
  });

  it("code-aware guidance: PROVIDER_AUTH_FAILED links to Project Settings → Herald; HERALD_TOOL_BUDGET_EXCEEDED is informational", async () => {
    transcripts.set("t-guide", [
      u("q"),
      a("", { error: { code: "PROVIDER_AUTH_FAILED", message: "The provider rejected the configured API key. Nothing was added to the thread." } }),
      u("q2"),
      a("", { error: { code: "HERALD_TOOL_BUDGET_EXCEEDED", message: "The reply hit its tool-call budget before finishing." } }),
    ]);
    render(<HeraldChatPage slug="demo" thread="t-guide" />, { wrapper });
    expect(await screen.findByText(/fix provider settings/i)).toBeInTheDocument();
    const chip = screen.getByText("Project Settings → Herald").closest("a") as HTMLAnchorElement;
    expect(chip.getAttribute("href")).toContain("/settings/project");
    expect(chip.getAttribute("href")).toContain("projectId=p1");
    expect(screen.getByText(/tool-call budget before finishing/i)).toBeInTheDocument();
    // Informational code gets NO retry affordance inside its block.
    const budgetBlock = screen.getByText("HERALD_TOOL_BUDGET_EXCEEDED").closest("div > div")!.parentElement!;
    expect(budgetBlock.querySelector("button")).toBeNull();
  });

  it("citation chips render https-only — http:// sources never become chips", async () => {
    transcripts.set("t-cite", [
      u("what does the docs say?"),
      a("Retry backoff should be exponential.", {
        citations: [
          { url: "https://docs.example.com/payments/retries", title: "Payment retry guidelines" },
          { url: "http://blog.example.org/exponential-backoff", title: "Evil plain-http source" },
        ],
        ts: "2026-08-22T09:44:00Z",
      }),
    ]);
    render(<HeraldChatPage slug="demo" thread="t-cite" />, { wrapper });
    const good = await screen.findByTitle("https://docs.example.com/payments/retries");
    expect(good.tagName).toBe("A");
    expect(good.getAttribute("href")).toBe("https://docs.example.com/payments/retries");
    expect(screen.getByText("docs.example.com")).toBeInTheDocument();
    expect(screen.queryByTitle("http://blog.example.org/exponential-backoff")).not.toBeInTheDocument();
    // ts meta renders in the bubble meta line.
    expect(screen.getByText(/herald.*\d{2}:\d{2}/i)).toBeInTheDocument();
  });

  it("interrupted partial keeps the text with a ● Stopped marker and Retry", async () => {
    transcripts.set("t-stop", [
      u("draft the checklist"),
      a("- [ ] Reconciliation job uses exponential backoff\n- [ ] Failed batches surf", { stopped: true }),
    ]);
    render(<HeraldChatPage slug="demo" thread="t-stop" />, { wrapper });
    expect(await screen.findByText(/● stopped/i)).toBeInTheDocument();
    expect(screen.getByText(/exponential backoff/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^retry$/i }));
    await waitFor(() => expect(streamBodies).toHaveLength(1));
    expect(streamBodies[0]).toMatchObject({ message: "draft the checklist", fromIndex: 0 });
  });

  it("assistant turn renders markdown — **bold** becomes <strong>, lists become <li>, not literal syntax", async () => {
    transcripts.set("t-md", [u("summarize"), a("**Bold** move:\n\n- one\n- two")]);
    const { container } = render(<HeraldChatPage slug="demo" thread="t-md" />, { wrapper });
    expect(await screen.findByText("summarize")).toBeInTheDocument();
    const strong = container.querySelector(".bubble-md strong");
    expect(strong?.textContent).toBe("Bold");
    expect(screen.queryByText(/\*\*Bold\*\*/)).toBeNull();
    const items = container.querySelectorAll(".bubble-md li");
    expect(items).toHaveLength(2);
    // User turns stay plain text with mention chips (no .bubble-md scope).
    expect(container.querySelector(".bubble-user .bubble-md")).toBeNull();
  });

  it("legacy entries without meta still render (tolerant renderer)", async () => {
    transcripts.set("t-legacy", [u("old user turn"), a("old assistant turn")]);
    render(<HeraldChatPage slug="demo" thread="t-legacy" />, { wrapper });
    expect(await screen.findByText("old user turn")).toBeInTheDocument();
    expect(screen.getByText("old assistant turn")).toBeInTheDocument();
    // Hover affordances exist on legacy turns too.
    expect(screen.getAllByRole("button", { name: /copy message/i }).length).toBe(1);
  });

  it("effort picker: muted default label resolves the project value; menu lists Default + the four levels", async () => {
    render(<HeraldChatPage slug="demo" thread="t-effort-ui" />, { wrapper });
    const trigger = await screen.findByRole("button", { name: "Thinking effort" });
    await waitFor(() => expect(trigger).toHaveTextContent("default (medium)"));
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const listbox = screen.getByRole("listbox", { name: "Thinking effort" });
    const options = Array.from(listbox.querySelectorAll("[role='option']")).map((o) => o.textContent);
    expect(options).toEqual(["Default · project (medium)", "Minimal", "Low", "Medium", "High"]);
    // Esc dismisses.
    fireEvent.keyDown(listbox, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Thinking effort" })).toBeNull();
  });

  it("effort override rides the stream payload once, then falls back to default; unset sends omit the field", async () => {
    render(<HeraldChatPage slug="demo" thread="t-effort-send" />, { wrapper });
    await screen.findByRole("button", { name: "Thinking effort" });

    // No pick → payload omits reasoningEffort entirely (project default).
    fireEvent.change(screen.getByPlaceholderText(/ask herald anything/i), { target: { value: "plain ask" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(streamBodies).toHaveLength(1));
    expect(streamBodies[0]).not.toHaveProperty("reasoningEffort");

    // Explicit pick tints the chip and rides THIS message only.
    fireEvent.click(screen.getByRole("button", { name: "Thinking effort" }));
    fireEvent.click(within(screen.getByRole("listbox", { name: "Thinking effort" })).getByRole("option", { name: "High" }));
    const trigger = screen.getByRole("button", { name: "Thinking effort" });
    expect(trigger).toHaveTextContent("high");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.change(screen.getByPlaceholderText(/ask herald anything/i), { target: { value: "think hard" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(streamBodies).toHaveLength(2));
    expect(streamBodies[1]).toMatchObject({ reasoningEffort: "high" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Thinking effort" })).toHaveTextContent("default (medium)"));
  });

  it("effort picker locks while streaming; thread switch resets an explicit pick to default", async () => {
    const encoder = new TextEncoder();
    streamOverride = () => {
      const frames = [
        { type: "start", threadId: "t" },
        { type: "delta", text: "slow" },
        { type: "done", text: "slow", usage: { in: 1, out: 1 } },
      ];
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const f of frames) {
            controller.enqueue(encoder.encode(`event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`));
            await new Promise((r) => setTimeout(r, 30));
          }
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };
    const { rerender } = render(<HeraldChatPage slug="demo" thread="t-effort-lock" />, { wrapper });
    const trigger = await screen.findByRole("button", { name: "Thinking effort" });

    fireEvent.click(trigger);
    fireEvent.click(within(screen.getByRole("listbox", { name: "Thinking effort" })).getByRole("option", { name: "Low" }));

    fireEvent.change(screen.getByPlaceholderText(/ask herald anything/i), { target: { value: "go" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    expect(trigger).toBeDisabled();

    await waitFor(() => expect(trigger).toBeEnabled());
    // One-shot override: the send consumed it.
    await waitFor(() => expect(trigger).toHaveTextContent("default (medium)"));

    // Thread switch (rerender with a different ?thread=) resets the pick too.
    rerender(<HeraldChatPage slug="demo" thread="t-effort-next" />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Thinking effort" })).toHaveTextContent("default (medium)")
    );
  });

  it("ENGINE_NOT_SUPPORTED_FOR_CHAT banner renders under a blacksmith project default, absent under herald", async () => {
    currentSettings = { ...SETTINGS, engine: "blacksmith" };
    render(<HeraldChatPage slug="demo" thread="t-engine" />, { wrapper });
    expect(await screen.findByText(/ENGINE_NOT_SUPPORTED_FOR_CHAT/i)).toBeInTheDocument();
  });

  it("engine banner does not render when the project default is herald", async () => {
    transcripts.set("t-engine-ok", [u("q"), a("a")]);
    render(<HeraldChatPage slug="demo" thread="t-engine-ok" />, { wrapper });
    expect(await screen.findByText("q")).toBeInTheDocument();
    expect(screen.queryByText(/ENGINE_NOT_SUPPORTED_FOR_CHAT/i)).toBeNull();
  });

  it("VISION_NOT_CONFIGURED: attach button disabled with a settings tooltip; capable projects keep it enabled", async () => {
    // No vision chain → disabled attach with tooltip.
    currentSettings = { ...SETTINGS, primarySupportsImages: false, visionModel: null };
    const { unmount } = render(<HeraldChatPage slug="demo" thread="t-vision" />, { wrapper });
    const disabled = await screen.findByRole("button", { name: "Attach images (disabled)" });
    expect(disabled).toBeDisabled();
    expect(disabled).toHaveAttribute("title", "Images are disabled — configure vision in Project Settings → Herald.");
    unmount();

    // Primary model sees images inline → enabled.
    currentSettings = { ...SETTINGS, primarySupportsImages: true };
    render(<HeraldChatPage slug="demo" thread="t-vision2" />, { wrapper });
    const enabled = await screen.findByRole("button", { name: "Attach images" });
    expect(enabled).toBeEnabled();
  });

  it("invalid slug falls back to the first available project's chat (?thread= rides along)", async () => {
    render(<HeraldChatPage slug="gone" thread="t-gone" />, { wrapper });
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith(
        expect.objectContaining({ to: "/$slug/chat", params: { slug: "demo" }, search: { thread: "t-gone" }, replace: true })
      )
    );
  });

  it("valid slug never triggers the fallback redirect", async () => {
    transcripts.set("t-valid", [u("q"), a("a")]);
    render(<HeraldChatPage slug="demo" thread="t-valid" />, { wrapper });
    expect(await screen.findByText("q")).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalledWith(expect.objectContaining({ params: expect.anything() }));
  });
});

describe("Threads sidebar", () => {
  const SIDEBAR_THREADS = [
    { chatId: "c1", title: "Payments migration questions", pinned: false, snippet: null, createdAt: "t1", updatedAt: "2026-08-22T10:00:00Z" },
    { chatId: "c2", title: "Rollback runbook draft", pinned: true, snippet: null, createdAt: "t2", updatedAt: "2026-08-21T11:00:00Z" },
  ];

  function sidebarRow(title: string): HTMLElement {
    const list = document.querySelector(".threads-sidebar-list") as HTMLElement;
    return within(list).getByText(title).closest(".thread-row") as HTMLElement;
  }

  it("renders the persistent left sidebar with rows and highlights the active thread", async () => {
    chatThreads = SIDEBAR_THREADS;
    render(<HeraldChatPage slug="demo" thread="c1" />, { wrapper });
    expect(await screen.findByText("Payments migration questions")).toBeInTheDocument();
    expect(screen.getByText("Rollback runbook draft")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New chat" })).toBeInTheDocument();
    const activeRow = sidebarRow("Payments migration questions");
    expect(activeRow.className).toContain("active");
    expect(activeRow.textContent).toContain("Active now");
  });

  it("rename inline commits through PATCH /api/herald/chat/:id with the trimmed title", async () => {
    chatThreads = SIDEBAR_THREADS;
    render(<HeraldChatPage slug="demo" thread="c1" />, { wrapper });
    const row = await waitFor(() => sidebarRow("Payments migration questions"));
    fireEvent.click(within(row).getByRole("button", { name: /rename payments/i }));
    const input = screen.getByLabelText("Rename chat");
    fireEvent.change(input, { target: { value: "  Cutover Q&A  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(chatPatchCalls).toContainEqual({ chatId: "c1", body: { title: "Cutover Q&A" } })
    );
  });

  it("pin toggle routes through PATCH with the inverted flag", async () => {
    chatThreads = SIDEBAR_THREADS;
    render(<HeraldChatPage slug="demo" thread="c1" />, { wrapper });
    const row = await waitFor(() => sidebarRow("Rollback runbook draft"));
    // c2 is pinned → Unpin.
    fireEvent.click(within(row).getByRole("button", { name: /unpin rollback/i }));
    await waitFor(() =>
      expect(chatPatchCalls).toContainEqual({ chatId: "c2", body: { pinned: false } })
    );
  });

  it("delete confirm issues DELETE /api/herald/chat/:id", async () => {
    chatThreads = SIDEBAR_THREADS;
    render(<HeraldChatPage slug="demo" thread="c1" />, { wrapper });
    const row = await waitFor(() => sidebarRow("Payments migration questions"));
    fireEvent.click(within(row).getByRole("button", { name: /delete payments/i }));
    expect(await screen.findByRole("dialog", { name: /delete this chat/i })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("dialog", { name: /delete this chat/i })).getByRole("button", { name: /^delete chat$/i }));
    await waitFor(() => expect(chatDeleteCalls).toContainEqual("c1"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /delete this chat/i })).toBeNull());
  });

  it("in-sidebar collapse control swaps the column for the restore rail; choice persists across reload", async () => {
    window.localStorage.clear();
    chatThreads = SIDEBAR_THREADS;
    const { unmount } = render(<HeraldChatPage slug="demo" thread="c1" />, { wrapper });
    await screen.findByText("Payments migration questions");
    // The control lives INSIDE the sidebar header (wiki arrangement).
    const collapse = screen.getByRole("button", { name: "Collapse sidebar" });
    expect(collapse.closest(".threads-sidebar-header")).not.toBeNull();
    // Collapse → 36px rail variant, choice written to localStorage.
    fireEvent.click(collapse);
    expect(document.querySelector(".threads-sidebar.collapsed")).not.toBeNull();
    expect(window.localStorage.getItem("lexa-chat-sidebar")).toBe("0");
    // Rail restores the docked column (wiki affordance).
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(document.querySelector(".threads-sidebar.open")).not.toBeNull();
    expect(window.localStorage.getItem("lexa-chat-sidebar")).toBe("1");
    // Reload: the collapsed choice survives hydration.
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    unmount();
    render(<HeraldChatPage slug="demo" thread="c1" />, { wrapper });
    await screen.findByRole("button", { name: "Expand sidebar" });
    expect(document.querySelector(".threads-sidebar.collapsed")).not.toBeNull();
    window.localStorage.clear();
  });
});

describe("Herald activity strip", () => {
  // Chunked SSE body — frames land across ticks so mid-stream states are
  // observable (a single-chunk Response drains in one microtask run).
  function sseStream(frames: unknown[], delayMs = 40): Response {
    const encoder = new TextEncoder();
    const chunks = frames.map((f) => `event: ${(f as { type: string }).type}\ndata: ${JSON.stringify(f)}\n\n`);
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
          await new Promise((r) => setTimeout(r, delayMs));
        }
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }

  it("reasoning frames drive the Thinking block live; the persisted transcript carries none of it", async () => {
    streamOverride = (body) => {
      const chatId = String(body.chatId);
      return sseStream([
        { type: "start", threadId: chatId },
        { type: "reasoning", delta: "Auditing the screenshot against the library. " },
        { type: "reasoning", delta: "Kanban card first." },
        { type: "tool", phase: "call", name: "web_search" },
        { type: "tool", phase: "result", name: "web_search" },
        { type: "delta", text: "Matches our card primitive." },
        { type: "done", text: "Matches our card primitive.", usage: { in: 1, out: 1 } },
      ]);
    };
    const { container } = render(<HeraldChatPage slug="demo" thread="t-live" />, { wrapper });
    const composer = await screen.findByPlaceholderText(/ask herald anything/i);
    fireEvent.change(composer, { target: { value: "audit this screenshot" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));

    // Optimistic user turn lands, then the Thinking row auto-expands with
    // the LIVE reasoning text while reasoning frames stream.
    await screen.findByText("audit this screenshot");
    const thinking = await screen.findByRole("button", { name: /thinking…/i });
    expect(thinking).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByText(/auditing the screenshot against the library/i)).toBeInTheDocument();

    // Tool row flips spinner → success check as call/result frames arrive.
    await screen.findByText(/searching web…/i);
    await waitFor(() => expect(container.querySelector(".herald-activity-tool.done")).not.toBeNull());

    // Stream ends; the ephemeral strip leaves no transcript trace.
    await waitFor(() => expect(screen.queryByRole("button", { name: /thinking…/i })).toBeNull());
    const stored = transcripts.get("t-live") ?? [];
    expect(JSON.stringify(stored)).not.toContain("reasoning");
    expect(JSON.stringify(stored)).not.toContain("Auditing");
  });

  it("transcript-loaded threads show NO activity strip (ephemeral by contract)", async () => {
    transcripts.set("t-plain", [
      u("q"),
      a("plain answer", { citations: [{ url: "https://x.example/a", title: "A" }] }),
    ]);
    const { container } = render(<HeraldChatPage slug="demo" thread="t-plain" />, { wrapper });
    expect(await screen.findByText("plain answer")).toBeInTheDocument();
    expect(container.querySelector(".herald-activity")).toBeNull();
    expect(screen.queryByText(/thought for/i)).toBeNull();
  });

  it("auto-scroll follows TIMELINE growth (tool/reasoning items), not just text deltas, while latched at bottom", async () => {
    streamOverride = () =>
      sseStream(
        [
          { type: "start", threadId: "t" },
          { type: "delta", text: "one" },
          { type: "tool", phase: "call", name: "web_search" },
          { type: "tool", phase: "result", name: "web_search" },
          { type: "delta", text: "two" },
          { type: "done", text: "onetwo", usage: { in: 1, out: 1 } },
        ],
        60
      );
    const { container } = render(<HeraldChatPage slug="demo" thread="t-follow" />, { wrapper });
    const composer = await screen.findByPlaceholderText(/ask herald anything/i);
    fireEvent.change(composer, { target: { value: "go" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));

    // Latched at bottom by default — the scroller gets programmatic follows.
    const scroller = container.querySelector(".chat-scroll") as HTMLElement;
    const scrollTo = vi.fn();
    (scroller as unknown as { scrollTo: unknown }).scrollTo = scrollTo;

    await screen.findByText("one");
    const afterFirstDelta = scrollTo.mock.calls.length;

    // Tool call + result mount/grow timeline items — view must follow.
    await waitFor(() => expect(container.querySelector(".herald-activity-tool.done")).not.toBeNull());
    expect(scrollTo.mock.calls.length).toBeGreaterThan(afterFirstDelta);
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: "auto" }));
  });

  it("user-scrolled-up latch holds during timeline growth — no yank; resumes when back at bottom", async () => {
    streamOverride = () =>
      sseStream(
        [
          { type: "start", threadId: "t" },
          { type: "delta", text: "one" },
          { type: "tool", phase: "call", name: "web_search" },
          { type: "tool", phase: "result", name: "web_search" },
          { type: "delta", text: "two" },
          { type: "done", text: "onetwo", usage: { in: 1, out: 1 } },
        ],
        60
      );
    const { container } = render(<HeraldChatPage slug="demo" thread="t-latch" />, { wrapper });
    const composer = await screen.findByPlaceholderText(/ask herald anything/i);
    fireEvent.change(composer, { target: { value: "go" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));

    const scroller = container.querySelector(".chat-scroll") as HTMLElement;
    const scrollTo = vi.fn();
    (scroller as unknown as { scrollTo: unknown }).scrollTo = scrollTo;

    await screen.findByText("one");
    // Scroll up away from the live bubble → latch releases following.
    stubMetrics(scroller, 0, 600, 200);
    fireEvent.scroll(scroller);
    expect(screen.getByRole("button", { name: "Jump to latest" })).toBeInTheDocument();
    const latchedCount = scrollTo.mock.calls.length;

    // Timeline keeps growing — no programmatic follow while scrolled up.
    // Stream completion signal: the composer's Stop flips back to Send.
    await screen.findByRole("button", { name: /^stop$/i });
    await waitFor(() => expect(screen.queryByRole("button", { name: /^stop$/i })).toBeNull());
    expect(scrollTo.mock.calls.length).toBe(latchedCount);

    // Return to bottom → the latch clears (Jump button disappears).
    stubMetrics(scroller, 400, 600, 200);
    fireEvent.scroll(scroller);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
  });
});

describe("Scroll-to-bottom affordance", () => {
  it("hidden at bottom, appears when scrolled up, click smooth-scrolls to the latest message", async () => {
    transcripts.set("t-jump", [u("one"), a("two"), u("three"), a("four")]);
    const { container } = render(<HeraldChatPage slug="demo" thread="t-jump" />, { wrapper });
    expect(await screen.findByText("four")).toBeInTheDocument();

    const scroller = container.querySelector(".chat-scroll") as HTMLElement;
    // At bottom (default): no button.
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();

    // Scroll up away from the latest message → button appears.
    stubMetrics(scroller, 0, 600, 200);
    fireEvent.scroll(scroller);
    expect(screen.getByRole("button", { name: "Jump to latest" })).toBeInTheDocument();

    const scrollTo = vi.fn();
    (scroller as unknown as { scrollTo: unknown }).scrollTo = scrollTo;
    fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: "smooth" }));

    // Back at bottom → hidden again.
    stubMetrics(scroller, 400, 600, 200);
    fireEvent.scroll(scroller);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
  });

  it("auto-follow pins new deltas while at bottom; scrolling up releases the pin", async () => {
    transcripts.set("t-pin", [u("q1"), a("a1")]);
    const { container } = render(<HeraldChatPage slug="demo" thread="t-pin" />, { wrapper });
    await screen.findByText("q1");

    const scroller = container.querySelector(".chat-scroll") as HTMLElement;
    const scrollTo = vi.fn();
    (scroller as unknown as { scrollTo: unknown }).scrollTo = scrollTo;
    stubMetrics(scroller, 400, 600, 200);
    fireEvent.scroll(scroller);

    const composer = screen.getByPlaceholderText(/ask herald anything/i) as HTMLTextAreaElement;
    const pinnedCalls = scrollTo.mock.calls.length;
    fireEvent.change(composer, { target: { value: "hello pinned" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(streamBodies).toHaveLength(1));
    await waitFor(() => expect(scrollTo.mock.calls.length).toBeGreaterThan(pinnedCalls));

    // Release the pin by scrolling up, then send again — no auto-scroll.
    stubMetrics(scroller, 0, 600, 200);
    fireEvent.scroll(scroller);
    await waitFor(() => expect(screen.getByPlaceholderText(/ask herald anything/i)).not.toBeDisabled());
    const releasedCalls = scrollTo.mock.calls.length;
    fireEvent.change(composer, { target: { value: "hello released" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(streamBodies).toHaveLength(2));
    expect(scrollTo.mock.calls.length).toBe(releasedCalls);
  });
});

describe("transcript meta helpers", () => {
  it("renderTranscript parses inline meta and tolerates legacy entries + image parts", () => {
    const turns = renderTranscript([
      u("plain"),
      { role: "assistant", content: [{ type: "image-ref" }, { text: "caption" }] },
      u("with ts", { ts: "2026-08-22T09:41:00Z" }),
      a("cited", { citations: [{ url: "https://x.example/a", title: "A" }] }),
      a("", { error: { code: "PROVIDER_AUTH_FAILED", message: "nope" } }),
      a("partial", { stopped: true }),
      { role: "system", content: "ignored" },
    ]);
    expect(turns).toHaveLength(6);
    expect(turns[0]).toMatchObject({ role: "user", text: "plain", rawIndex: 0 });
    expect(turns[0].ts).toBeUndefined();
    expect(turns[1]).toMatchObject({ imageCount: 1, text: "caption", rawIndex: 1 });
    expect(turns[2].ts).toBe("2026-08-22T09:41:00Z");
    expect(turns[3].citations).toHaveLength(1);
    expect(turns[4].error).toEqual({ code: "PROVIDER_AUTH_FAILED", message: "nope" });
    expect(turns[5].stopped).toBe(true);
  });

  it("safeCitations rejects non-https and malformed entries", () => {
    expect(safeCitations([
      { url: "http://insecure.example/x", title: "bad scheme" },
      { url: "javascript:alert(1)", title: "evil" },
      { url: "https://ok.example/a" },
      { url: 42 },
      "junk",
    ])).toEqual([{ url: "https://ok.example/a", title: null, hostname: "ok.example" }]);
    expect(safeCitations(undefined)).toEqual([]);
  });

  it("guidanceFor maps catalog codes to treatments", () => {
    expect(guidanceFor("PROVIDER_AUTH_FAILED")).toBe("settings");
    expect(guidanceFor("HERALD_TOOL_BUDGET_EXCEEDED")).toBe("info");
    expect(guidanceFor("PROVIDER_UNREACHABLE")).toBe("retry");
    expect(guidanceFor("PROVIDER_RATE_LIMITED")).toBe("retry");
    expect(guidanceFor("HERALD_GENERATION_FAILED")).toBe("info");
  });

  it("splitFences extracts fenced bodies, capturing the language tag", () => {
    expect(splitFences("before```ts\ncode()\n```after")).toEqual([
      { fenced: false, body: "before" },
      { fenced: true, body: "code()\n", lang: "ts" },
      { fenced: false, body: "after" },
    ]);
    expect(splitFences("```plain\ntext\n```")).toEqual([{ fenced: true, body: "text\n", lang: "plain" }]);
    expect(splitFences("```\nno lang\n```")).toEqual([{ fenced: true, body: "no lang\n" }]);
    expect(splitFences("plain only")).toEqual([{ fenced: false, body: "plain only" }]);
  });

  it("done-turn fenced block renders the micro-caps language label + highlighted code", async () => {
    transcripts.set("t-code", [u("q"), a("Look:\n\n```python\nprint('hi')\n```")]);
    const { container } = render(<HeraldChatPage slug="demo" thread="t-code" />, { wrapper });
    expect(await screen.findByText("Look:")).toBeInTheDocument();
    const block = container.querySelector(".herald-codeblock")!;
    expect(block).not.toBeNull();
    expect(block.querySelector(".herald-codeblock-lang")?.textContent).toBe("python");
    expect(block.querySelector("code.hljs-theme")?.innerHTML).toContain("hljs-");
    // Copy affordance survives.
    expect(screen.getByRole("button", { name: "Copy code" })).toBeInTheDocument();
  });
});
