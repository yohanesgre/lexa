import type { AssistantSettingsMasked } from "../../shared/assistant";

// The single builtin Assistant agent (the agent-runtime tier was removed).
// The persona is never picked client-side; the server re-resolves it.
export const ASSISTANT_AGENT_ID = "assistant";
export const ASSISTANT_AGENT_NAME = "Assistant Agent";

// Current phase: image attach is enabled ONLY when a vision agent model is
// configured — images always route through it (internal `analyze_image`
// delegation). Without one, the composer keeps attach disabled and the send is
// refused with VISION_NOT_CONFIGURED. The `primary_supports_images` inline path
// is the later target (inline vision parts when the primary is multimodal), so
// it is intentionally not a gate here.
export function hasVisionCapability(settings: AssistantSettingsMasked | null | undefined): boolean {
  if (!settings) return false;
  return Boolean(settings.visionModel);
}
