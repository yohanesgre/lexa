// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { HeraldChatPage, renderTranscript, safeCitations, guidanceFor, splitFences } from "./HeraldChatPage";
import { deriveChatTitle } from "../../../shared/herald";

const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
  Link: ({ to, params, className, children }: { to: string; params?: Record<string, string>; className?: string | undefined; children?: React.ReactNode }) => (
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
    fireEvent.click(regenButtons[0]!);

    await waitFor(() => expect(streamBodies).toHaveLength(1));
    expect(streamBodies[0]).toMatchObject({ message: "latest ask", fromIndex: 2 });
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
    expect(turns[0]!).toMatchObject({ role: "user", text: "plain", rawIndex: 0 });
    expect(turns[0]!.ts).toBeUndefined();
    expect(turns[1]!).toMatchObject({ imageCount: 1, text: "caption", rawIndex: 1 });
    expect(turns[2]!.ts).toBe("2026-08-22T09:41:00Z");
    expect(turns[3]!.citations).toHaveLength(1);
    expect(turns[4]!.error).toEqual({ code: "PROVIDER_AUTH_FAILED", message: "nope" });
    expect(turns[5]!.stopped).toBe(true);
  });
});
describe("optimistic sidebar", () => {
  function sseStream(frames: unknown[], delayMs = 30): Response {
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

  it("new chat: sidebar shows optimistic thread after first delta before done", async () => {
    const newId = "c-new-opt";
    const message = "My new thread title that is long enough to be derived and truncated at 60 chars maybe";
    const expectedTitle = deriveChatTitle(message);
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const key = `${init?.method ?? "GET"} ${url.split("?")[0]}`;
      if (key.startsWith("POST /api/herald/chat/stream")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        streamBodies.push(body);
        return Promise.resolve(
          sseStream(
            [
              { type: "start", threadId: String(body.chatId) },
              { type: "delta", text: "hello" },
              { type: "done", text: "hello", usage: { in: 1, out: 1 } },
            ],
            30
          )
        );
      }
      if (key.startsWith("GET /api/herald/chats/p1")) {
        if (streamBodies.length > 0) {
          const sid = String((streamBodies[0] as Record<string, unknown>).chatId);
          const smsg = String((streamBodies[0] as Record<string, unknown>).message);
          const title = deriveChatTitle(smsg);
          const now = new Date().toISOString();
          return Promise.resolve(
            new Response(JSON.stringify({ data: [{ chatId: sid, title, pinned: false, snippet: null, createdAt: now, updatedAt: now }] }), {
              status: 200,
            })
          );
        }
        return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
      }
      if (key.startsWith("GET /api/herald/chat/")) {
        const chatId = url.split("/").pop()!.split("?")[0]!;
        const msgs = transcripts.get(chatId) ?? [];
        return Promise.resolve(
          new Response(
            JSON.stringify({
              chatId,
              projectId: "p1",
              ownerUserId: null,
              agentId: null,
              skillId: null,
              messages: msgs,
              summary: null,
              summarizedCount: 0,
              createdAt: "t",
              updatedAt: "t",
            }),
            { status: 200 }
          )
        );
      }
      if (key.startsWith("PATCH /api/herald/chat/") || key.startsWith("DELETE /api/herald/chat/")) {
        return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
      }
      const routes: Record<string, unknown> = {
        "GET /api/projects": { data: [PROJECT], nextCursor: null },
        "GET /api/herald/settings/p1": currentSettings,
        "GET /api/agents": { data: [{ id: "hearth-herald", name: "Herald Agent", description: "", instructions: "", skillIds: [] }] },
        "GET /api/skills": { data: [] },
      };
      if (!(key in routes)) return Promise.reject(new Error(`unmocked: ${key}`));
      return Promise.resolve(new Response(JSON.stringify(routes[key]), { status: 200 }));
    });

    render(<HeraldChatPage slug="demo" thread={newId} />, { wrapper });
    await screen.findByPlaceholderText(/ask herald anything/i);
    expect(screen.getByText(/no threads yet/i)).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/ask herald anything/i), { target: { value: message } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));

    await waitFor(() => expect(screen.getByText(expectedTitle)).toBeInTheDocument(), { timeout: 2000 });
    const list = document.querySelector(".threads-sidebar-list") as HTMLElement;
    const row = within(list).getByText(expectedTitle).closest(".thread-row") as HTMLElement;
    expect(row.className).toContain("active");

    await waitFor(() => expect(screen.getByText(expectedTitle)).toBeInTheDocument(), { timeout: 2000 });
  });
});
