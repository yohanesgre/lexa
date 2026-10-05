import { describe, expect, it } from "vitest";
import { buildInternalDepsForRun, type LexaAssistantEnv } from "./agent";
import type { InternalAuthIdentity } from "./internal-auth";

const IDENTITY: InternalAuthIdentity = { actorUserId: "u1", projectId: "p1", threadKey: "chat:1" };
const MASTER_KEY = "deps-test-master-key-0123456789";

function env(overrides: Partial<LexaAssistantEnv> = {}): LexaAssistantEnv {
  return { LXK_SECRETS_MASTER_KEY: MASTER_KEY, ...overrides };
}

const SERVICE = { fetch: () => Promise.resolve(new Response(null, { status: 200 })) } as unknown as NonNullable<
  LexaAssistantEnv["ASSISTANT_SERVICE"]
>;

describe("buildInternalDepsForRun", () => {
  it("returns null without a master key or identity", () => {
    expect(buildInternalDepsForRun(env({ LXK_SECRETS_MASTER_KEY: undefined }), IDENTITY)).toBeNull();
    expect(buildInternalDepsForRun(env(), null)).toBeNull();
  });

  it("prefers the stored origin over LXK_PUBLIC_URL", () => {
    const deps = buildInternalDepsForRun(env({ LXK_PUBLIC_URL: "https://public.test" }), IDENTITY, "https://stored.test");
    expect(deps?.origin).toBe("https://stored.test");
  });

  it("uses a trimmed LXK_PUBLIC_URL", () => {
    const deps = buildInternalDepsForRun(env({ LXK_PUBLIC_URL: " https://public.test " }), IDENTITY);
    expect(deps?.origin).toBe("https://public.test");
  });

  it("treats a whitespace-only LXK_PUBLIC_URL as unset", () => {
    expect(buildInternalDepsForRun(env({ LXK_PUBLIC_URL: "   " }), IDENTITY)).toBeNull();
    const deps = buildInternalDepsForRun(env({ LXK_PUBLIC_URL: "   ", ASSISTANT_SERVICE: SERVICE }), IDENTITY);
    expect(deps?.origin).toBe("https://assistant.internal");
  });
});
