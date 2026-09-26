import type { AssistantSettingsMasked } from "../../shared/assistant";

// The single builtin Assistant agent (the agent-runtime tier was removed).
// The persona is never picked client-side; the server re-resolves it.
export const ASSISTANT_AGENT_ID = "assistant";
export const ASSISTANT_AGENT_NAME = "Assistant Agent";

// Vision resolution order (per request): primary_supports_images=1 → inline
// parts; else vision_model configured → internal analyze_image delegation;
// else attachments are rejected up front with VISION_NOT_CONFIGURED.
export function hasVisionCapability(settings: AssistantSettingsMasked | null | undefined): boolean {
  if (!settings) return false;
  return Boolean(settings.primarySupportsImages || settings.visionModel);
}
