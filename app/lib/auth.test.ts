import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSessionClient, signOut } from "./auth";

// Root beforeLoad + useAuthBounce ask for the session on load/navigation; the
// in-flight/TTL window must collapse those into one GET /api/auth/get-session.
describe("client session dedupe", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shares one in-flight request and drops a result cached during a mutation", async () => {
    let releaseSignOut!: () => void;
    const signOutGate = new Promise<void>((resolve) => {
      releaseSignOut = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/sign-out") && init?.method === "POST") {
        await signOutGate;
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ session: null, user: null }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const [first, second] = await Promise.all([fetchSessionClient(), fetchSessionClient()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ session: null, user: null });
    expect(second).toEqual(first);

    await fetchSessionClient();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const pendingSignOut = signOut();
    // A get-session that resolves while the mutation is in flight caches the
    // pre-mutation answer; the post-mutation read must not reuse it.
    await fetchSessionClient();
    releaseSignOut();
    await pendingSignOut;
    await fetchSessionClient();

    // get(1) + sign-out(2) + in-window get(3) + post-mutation get(4)
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
