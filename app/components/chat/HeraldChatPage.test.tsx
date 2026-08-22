// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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
};

const PROJECT = { id: "p1", slug: "demo", name: "Demo", description: "", repos: [], createdAt: "t", updatedAt: "t" };

function sse(frames: unknown[]): Response {
  const body = frames.map((f) => `event: ${(f as { type: string }).type}\ndata: ${JSON.stringify(f)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

let transcripts = new Map<string, unknown[]>();
const streamBodies: Record<string, unknown>[] = [];
const fetchMock = vi.fn();

function mockFetch() {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const key = `${init?.method ?? "GET"} ${url.split("?")[0]}`;
    if (key.startsWith("POST /api/herald/chat/stream")) {
      streamBodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(sse([{ type: "start", threadId: "t" }, { type: "done", text: "ok", usage: { in: 1, out: 1 } }]));
    }
    if (key.startsWith("GET /api/herald/chat/")) {
      const chatId = url.split("/").pop()!;
      return Promise.resolve(new Response(JSON.stringify({ chatId, projectId: "p1", ownerUserId: null, agentId: null, skillId: null, messages: transcripts.get(chatId) ?? [], summary: null, summarizedCount: 0, createdAt: "t", updatedAt: "t" }), { status: 200 }));
    }
    const routes: Record<string, unknown> = {
      "GET /api/projects": { data: [PROJECT], nextCursor: null },
      "GET /api/herald/settings/p1": SETTINGS,
      "GET /api/herald/chats/p1": { data: [] },
      "GET /api/agents": { data: [{ id: "lexa", name: "Lexa agent", description: "", instructions: "", skillIds: [] }] },
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

beforeEach(() => {
  transcripts = new Map();
  streamBodies.length = 0;
  navigateMock.mockReset();
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

  it("legacy entries without meta still render (tolerant renderer)", async () => {
    transcripts.set("t-legacy", [u("old user turn"), a("old assistant turn")]);
    render(<HeraldChatPage slug="demo" thread="t-legacy" />, { wrapper });
    expect(await screen.findByText("old user turn")).toBeInTheDocument();
    expect(screen.getByText("old assistant turn")).toBeInTheDocument();
    // Hover affordances exist on legacy turns too.
    expect(screen.getAllByRole("button", { name: /copy message/i }).length).toBe(1);
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

  it("splitFences extracts fenced bodies (language tag stripped)", () => {
    expect(splitFences("before```ts\ncode()\n```after")).toEqual([
      { fenced: false, body: "before" },
      { fenced: true, body: "code()\n" },
      { fenced: false, body: "after" },
    ]);
    expect(splitFences("plain only")).toEqual([{ fenced: false, body: "plain only" }]);
  });
});
