import { describe, expect, it } from "vitest";
import {
  ASSISTANT_AGENT_ROUTE_PREFIX,
  INTERNAL_ASSISTANT_ROUTE_PREFIX,
  authorizeInternalRequest,
  handleAssistantAgentRequest,
  parseThreadKey,
  stripInternalHeaders,
  type AssistantGateDeps,
  type AssistantThreadRow,
} from "./agent-gate";
import {
  INTERNAL_AUTH_ACTOR_HEADER,
  INTERNAL_AUTH_HEADER,
  INTERNAL_AUTH_PROJECT_HEADER,
  INTERNAL_AUTH_THREAD_HEADER,
  signInternalAuth,
  verifyInternalAuth,
  type InternalAuthIdentity,
} from "./internal-auth";

const SECRET = "test-master-key-0123456789";
const NOW_MS = 1_700_000_000_000;
const AGENT_URL = `http://lexa.test${ASSISTANT_AGENT_ROUTE_PREFIX}`;

function chatRow(ownerUserId: string | null = "user-1"): AssistantThreadRow {
  return { documentType: "chat", documentId: "abc", projectId: "proj-1", ownerUserId };
}

function makeDeps(overrides: Partial<AssistantGateDeps> = {}): AssistantGateDeps {
  return {
    getSession: async () => ({ user: { id: "user-1" } }),
    loadThread: async () => chatRow(),
    canReadProject: async () => true,
    upsertChatThread: async ({ documentId, projectId, ownerUserId }) => ({
      documentType: "chat",
      documentId,
      projectId,
      ownerUserId,
    }),
    masterKey: SECRET,
    nowMs: () => NOW_MS,
    ...overrides,
  };
}

describe("parseThreadKey", () => {
  it("accepts the three document types and rejects unknown or malformed keys", () => {
    expect(parseThreadKey("chat:abc")).toEqual({ documentType: "chat", documentId: "abc" });
    expect(parseThreadKey("task:5")).toEqual({ documentType: "task", documentId: "5" });
    expect(parseThreadKey("wiki:root/child")).toEqual({ documentType: "wiki", documentId: "root/child" });
    expect(parseThreadKey("chat:")).toBeNull();
    expect(parseThreadKey(":abc")).toBeNull();
    expect(parseThreadKey("issue:1")).toBeNull();
    expect(parseThreadKey("chat")).toBeNull();
  });
});

describe("stripInternalHeaders", () => {
  it("drops every X-Lexa-* header case-insensitively and keeps the rest", () => {
    const headers = stripInternalHeaders({
      "X-Lexa-Internal": "spoofed",
      "x-lexa-actor-userid": "evil",
      Cookie: "session=1",
      "Content-Type": "application/json",
    });
    expect(headers.get("X-Lexa-Internal")).toBeNull();
    expect(headers.get("x-lexa-actor-userid")).toBeNull();
    expect(headers.get("cookie")).toBe("session=1");
    expect(headers.get("content-type")).toBe("application/json");
  });
});

describe("handleAssistantAgentRequest", () => {
  it("401s with NO_USER_CONTEXT when there is no session", async () => {
    const outcome = await handleAssistantAgentRequest(
      new Request(`${AGENT_URL}chat%3Aabc`),
      makeDeps({ getSession: async () => null })
    );
    expect(outcome).toMatchObject({ kind: "error", status: 401, code: "NO_USER_CONTEXT" });
  });

  it("404s when the chat row is missing and no project is authorised", async () => {
    const outcome = await handleAssistantAgentRequest(
      new Request(`${AGENT_URL}chat%3Aabc`),
      makeDeps({ loadThread: async () => null, canReadProject: async () => false })
    );
    expect(outcome).toMatchObject({ kind: "error", status: 404, code: "ASSISTANT_THREAD_NOT_FOUND" });
  });

  it("404s when the chat row is owned by another user", async () => {
    const outcome = await handleAssistantAgentRequest(
      new Request(`${AGENT_URL}chat%3Aabc`),
      makeDeps({ loadThread: async () => chatRow("user-2") })
    );
    expect(outcome).toMatchObject({ kind: "error", status: 404, code: "ASSISTANT_THREAD_NOT_FOUND" });
  });

  it("404s when a task/wiki thread is missing or unreadable", async () => {
    const missing = await handleAssistantAgentRequest(
      new Request(`${AGENT_URL}task%3A5`),
      makeDeps({ loadThread: async () => null })
    );
    expect(missing).toMatchObject({ kind: "error", status: 404, code: "ASSISTANT_THREAD_NOT_FOUND" });
    const denied = await handleAssistantAgentRequest(
      new Request(`${AGENT_URL}wiki%3A9`),
      makeDeps({
        loadThread: async () => ({ documentType: "wiki", documentId: "9", projectId: "proj-1", ownerUserId: null }),
        canReadProject: async () => false,
      })
    );
    expect(denied).toMatchObject({ kind: "error", status: 404, code: "ASSISTANT_THREAD_NOT_FOUND" });
  });

  it("502s with ASSISTANT_UNAVAILABLE when the master key is absent", async () => {
    const outcome = await handleAssistantAgentRequest(
      new Request(`${AGENT_URL}chat%3Aabc`),
      makeDeps({ masterKey: undefined })
    );
    expect(outcome).toMatchObject({ kind: "error", status: 502, code: "ASSISTANT_UNAVAILABLE" });
  });

  it("forwards an owned chat thread with re-signed, de-spoofed identity headers", async () => {
    const outcome = await handleAssistantAgentRequest(
      new Request(`${AGENT_URL}chat%3Aabc`, {
        headers: { "X-Lexa-Internal": "spoofed", "X-Lexa-Actor-UserId": "evil", Cookie: "session=1" },
      }),
      makeDeps()
    );
    if (outcome.kind !== "forward") throw new Error("expected forward");
    const identity: InternalAuthIdentity = { actorUserId: "user-1", projectId: "proj-1", threadKey: "chat:abc" };
    expect(outcome.identity).toEqual(identity);
    expect(outcome.headers.get(INTERNAL_AUTH_ACTOR_HEADER)).toBe("user-1");
    expect(outcome.headers.get(INTERNAL_AUTH_PROJECT_HEADER)).toBe("proj-1");
    expect(outcome.headers.get(INTERNAL_AUTH_THREAD_HEADER)).toBe("chat:abc");
    expect(outcome.headers.get("cookie")).toBe("session=1");
    await expect(
      verifyInternalAuth(SECRET, outcome.headers.get(INTERNAL_AUTH_HEADER), identity, { nowMs: NOW_MS })
    ).resolves.toBe(true);
    expect(outcome.headers.get(INTERNAL_AUTH_HEADER)).not.toBe("spoofed");
  });

  it("upserts a missing chat thread after validating ?projectId, then forwards", async () => {
    const upserts: string[] = [];
    const outcome = await handleAssistantAgentRequest(
      new Request(`${AGENT_URL}chat%3Aabc?projectId=proj-9`),
      makeDeps({
        loadThread: async () => null,
        upsertChatThread: async ({ documentId, projectId, ownerUserId }) => {
          upserts.push(`${documentId}:${projectId}:${ownerUserId}`);
          return { documentType: "chat", documentId, projectId, ownerUserId };
        },
      })
    );
    expect(upserts).toEqual(["abc:proj-9:user-1"]);
    if (outcome.kind !== "forward") throw new Error("expected forward");
    expect(outcome.identity.projectId).toBe("proj-9");
  });

  it("forwards a readable task thread", async () => {
    const outcome = await handleAssistantAgentRequest(
      new Request(`${AGENT_URL}task%3A5`),
      makeDeps({
        loadThread: async () => ({ documentType: "task", documentId: "5", projectId: "proj-2", ownerUserId: null }),
      })
    );
    if (outcome.kind !== "forward") throw new Error("expected forward");
    expect(outcome.threadKey).toBe("task:5");
    expect(outcome.identity.projectId).toBe("proj-2");
  });
});

describe("authorizeInternalRequest", () => {
  it("returns unavailable without a master key, unauthorized without a valid signature, ok with one", async () => {
    const identity: InternalAuthIdentity = { actorUserId: "user-1", projectId: "proj-1", threadKey: "chat:abc" };
    const signed = await signInternalAuth(SECRET, identity, NOW_MS);
    const withHeaders = new Request(`http://lexa.test${INTERNAL_ASSISTANT_ROUTE_PREFIX}noop`, {
      headers: {
        [INTERNAL_AUTH_ACTOR_HEADER]: identity.actorUserId,
        [INTERNAL_AUTH_PROJECT_HEADER]: identity.projectId,
        [INTERNAL_AUTH_THREAD_HEADER]: identity.threadKey,
        [INTERNAL_AUTH_HEADER]: signed,
      },
    });
    await expect(authorizeInternalRequest(withHeaders, undefined)).resolves.toBe("unavailable");
    await expect(authorizeInternalRequest(new Request(withHeaders.url), SECRET)).resolves.toBe("unauthorized");
    // verifyInternalAuth uses Date.now() inside authorizeInternalRequest, so the
    // signed header must be fresh relative to the wall clock.
    const liveSigned = await signInternalAuth(SECRET, identity);
    const live = new Request(withHeaders.url, {
      headers: {
        [INTERNAL_AUTH_ACTOR_HEADER]: identity.actorUserId,
        [INTERNAL_AUTH_PROJECT_HEADER]: identity.projectId,
        [INTERNAL_AUTH_THREAD_HEADER]: identity.threadKey,
        [INTERNAL_AUTH_HEADER]: liveSigned,
      },
    });
    await expect(authorizeInternalRequest(live, SECRET)).resolves.toBe("ok");
  });
});
