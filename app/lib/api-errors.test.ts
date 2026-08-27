// @vitest-environment jsdom
// Browser API client — error mapping: status/code/details extraction, malformed
// JSON, network failure, and the remaining DELETE/204 paths.
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as api from "./api";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  document.head.innerHTML = "";

});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const envelope = (code: string, message: string, details?: unknown) =>
  new Response(JSON.stringify({ error: { code, message, ...(details !== undefined ? { details } : {}) } }), {
    status: code === "WIP_LIMIT" ? 409 : code === "TASK_NOT_FOUND" ? 404 : code === "REQUIRED_FIELD" ? 422 : code === "FORBIDDEN" ? 403 : 401,
    headers: { "Content-Type": "application/json" },
  });

type ApiErrorLike = Error & { code?: string | undefined; details?: unknown };

async function failureOf(p: Promise<unknown>): Promise<ApiErrorLike> {
  try {
    await p;
    throw new Error("expected a rejection");
  } catch (e) {
    return e as ApiErrorLike;
  }
}

describe("api error mapping", () => {
  it("401 → message from envelope, code set, status on the error is not present (client errors carry code+details only)", async () => {
    fetchMock.mockResolvedValue(envelope("UNAUTHORIZED", "Invalid or missing API key"));
    const err = await failureOf(api.listProjects());
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("UNAUTHORIZED");
    expect(err.message).toBe("Invalid or missing API key");
  });

  it("403 FORBIDDEN", async () => {
    fetchMock.mockResolvedValue(envelope("FORBIDDEN", "Admin role required"));
    const err = await failureOf(api.listUsers());
    expect(err.code).toBe("FORBIDDEN");
    expect(err.message).toBe("Admin role required");
  });

  it("404 with details", async () => {
    fetchMock.mockResolvedValue(envelope("TASK_NOT_FOUND", "Task not found", { id: "nope" }));
    const err = await failureOf(api.getWikiPage("demo", "nope"));
    expect(err.code).toBe("TASK_NOT_FOUND");
    expect(err.details).toEqual({ id: "nope" });
  });

  it("409 WIP_LIMIT with details", async () => {
    fetchMock.mockResolvedValue(envelope("WIP_LIMIT", "Column 'Todo' is at its WIP limit of 1", { column: "Todo", limit: 1, current: 1 }));
    const err = await failureOf(api.moveTask("demo", "t1", { columnId: "c1", swimlaneId: "s1" }));
    expect(err.code).toBe("WIP_LIMIT");
    expect(err.details).toEqual({ column: "Todo", limit: 1, current: 1 });
    expect(err.message).toContain("WIP limit of 1");
  });

  it("422 REQUIRED_FIELD", async () => {
    fetchMock.mockResolvedValue(envelope("REQUIRED_FIELD", "Field 'assignee' is required in column 'Todo'", { field: "assignee", column: "Todo" }));
    const err = await failureOf(api.createTask("demo", { columnId: "c1", title: "X" }));
    expect(err.code).toBe("REQUIRED_FIELD");
    expect((err.details as { field: string }).field).toBe("assignee");
  });

  it("500 with a JSON envelope keeps the server message", async () => {
    fetchMock.mockResolvedValue(envelope("INTERNAL", "boom"));
    const err = await failureOf(api.getDashboard());
    expect(err.code).toBe("INTERNAL");
    expect(err.message).toBe("boom");
  });

  it("error response without a JSON envelope → HTTP <status> fallback message", async () => {
    fetchMock.mockResolvedValue(new Response("plain text error", { status: 500 }));
    const err = await failureOf(api.getDashboard());
    expect(err.code).toBeUndefined();
    expect(err.message).toBe("HTTP 500");
  });

  it("malformed JSON on a success response rejects with the JSON error", async () => {
    fetchMock.mockResolvedValue(new Response("not json {{{", { status: 200, headers: { "Content-Type": "application/json" } }));
    await expect(api.listProjects()).rejects.toThrow(/Unexpected|JSON/);
  });

  it("network failure propagates the fetch error", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const err = await failureOf(api.listProjects());
    expect(err).toBeInstanceOf(TypeError);
    expect(err.message).toBe("Failed to fetch");
  });

  it("no key → the request still goes out without Authorization (server rejects)", async () => {
    fetchMock.mockResolvedValue(envelope("UNAUTHORIZED", "Invalid or missing API key"));
    const err = await failureOf(api.listProjects());
    expect(err.code).toBe("UNAUTHORIZED");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});

describe("api remaining deletes map 204 to undefined", () => {
  for (const [name, call] of [
    ["deleteProject", () => api.deleteProject("demo")],
    ["deleteColumn", () => api.deleteColumn("demo", "c1")],
    ["deleteSwimlane", () => api.deleteSwimlane("demo", "m1")],
    ["deleteWikiPage", () => api.deleteWikiPage("demo", "home")],
    ["deleteApiKey", () => api.deleteApiKey("k1")],
    ["deleteHearthAgent", () => api.deleteHearthAgent("a1")],
    ["deleteHearthSkill", () => api.deleteHearthSkill("s1")],
    ["deleteComment", () => api.deleteComment("demo", "t1", 1)],
    ["removeTaskLink", () => api.removeTaskLink("demo", "t1", "l1")],
  ] as [string, () => Promise<unknown>][]) {
    it(name, async () => {
      fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
      await expect(call()).resolves.toBeUndefined();
    });
  }
});
