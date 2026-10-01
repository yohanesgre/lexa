// Capability discovery (ADR-0003 §F.2): one honest signal per flavor instead of
// dead-but-wired endpoints. Unauthenticated, leak-free, served before boot and
// without any DB read. The assistant is Workers-only and additionally requires
// the secrets master key (HMAC derivation + provider-secret decryption), so the
// Bun flavor always reports `assistant:false`.

import type { RuntimeEnv } from "./env";

export type AssistantFlavor = "bun" | "workers";

export interface Capabilities {
  assistant: boolean;
  flavor: AssistantFlavor;
}

export interface CapabilityEnv {
  LXK_SECRETS_MASTER_KEY?: string | undefined;
}

/** The assistant is available only where the master key is resolvable. */
export function hasSecretsMasterKey(env: CapabilityEnv): boolean {
  const key = env.LXK_SECRETS_MASTER_KEY;
  return typeof key === "string" && key.length > 0;
}

/** The `GET /api/capabilities` JSON body for a flavor. */
export function capabilities(flavor: AssistantFlavor, env: CapabilityEnv): Capabilities {
  return { assistant: flavor === "workers" && hasSecretsMasterKey(env), flavor };
}

export function capabilitiesFromRuntimeEnv(flavor: AssistantFlavor, env: RuntimeEnv): Capabilities {
  return capabilities(flavor, env);
}
