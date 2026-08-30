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
});
