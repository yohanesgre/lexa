// @vitest-environment jsdom
import { describe, expect, it, afterEach, vi } from "vitest";
import { getSession } from "./auth";

const fetchMock = vi.fn();

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("getSession null-body normalization", () => {
  it("get-session returning HTTP 200 with a null body resolves to an empty session (SSR crash guard)", async () => {
    // Better Auth returns literal null (no JSON object) when unauthenticated —
    // the SSR __root guard read res.session and crashed on null.
    fetchMock.mockResolvedValue(
      new Response("null", { status: 200, headers: { "Content-Type": "application/json" } })
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await getSession();
    expect(res).toEqual({ session: null, user: null });
    expect(res.session).toBeNull();
  });

  it("get-session returning a real session passes through unchanged", async () => {
    const body = {
      session: { id: "s1", userId: "u1", expiresAt: "t", createdAt: "t" },
      user: { id: "u1", email: "y@lexa.test", name: "Y", role: "superadmin", createdAt: "t", lastSeen: null },
    };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await getSession();
    expect(res.session?.id).toBe("s1");
    expect(res.user?.email).toBe("y@lexa.test");
  });

  it("non-ok responses degrade to an empty session", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await getSession();
    expect(res).toEqual({ session: null, user: null });
  });
});
