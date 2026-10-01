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
  // Chat attachments (images + docs) ride the assistant chat stream, so they
  // need the assistant and are refused outright by the LXK_DISABLE_CHAT_ATTACHMENTS
  // kill switch. The frontend gate is this flag; the server refuses regardless.
  chatAttachments: boolean;
  // Bulk task actions (multi-select on the Tasks page). Available on every
  // flavor; refused outright by the LXK_DISABLE_TASKS_BULK kill switch. The
  // frontend gate is this flag; the endpoint refuses regardless.
  tasksBulk: boolean;
}

export interface CapabilityEnv {
  LXK_SECRETS_MASTER_KEY?: string | undefined;
  LXK_DISABLE_CHAT_ATTACHMENTS?: string | undefined;
  LXK_DISABLE_TASKS_BULK?: string | undefined;
}

/** The assistant is available only where the master key is resolvable. */
export function hasSecretsMasterKey(env: CapabilityEnv): boolean {
  const key = env.LXK_SECRETS_MASTER_KEY;
  return typeof key === "string" && key.length > 0;
}

/** False only when the operator set the kill switch to exactly "1". */
export function chatAttachmentsEnabled(env: CapabilityEnv): boolean {
  return env.LXK_DISABLE_CHAT_ATTACHMENTS !== "1";
}

/** False only when the operator set the kill switch to exactly "1". */
export function tasksBulkEnabled(env: CapabilityEnv): boolean {
  return env.LXK_DISABLE_TASKS_BULK !== "1";
}

/** The `GET /api/capabilities` JSON body for a flavor. */
export function capabilities(flavor: AssistantFlavor, env: CapabilityEnv): Capabilities {
  const assistant = flavor === "workers" && hasSecretsMasterKey(env);
  return {
    assistant,
    flavor,
    chatAttachments: assistant && chatAttachmentsEnabled(env),
    tasksBulk: tasksBulkEnabled(env),
  };
}

export function capabilitiesFromRuntimeEnv(flavor: AssistantFlavor, env: RuntimeEnv): Capabilities {
  return capabilities(flavor, env);
}
