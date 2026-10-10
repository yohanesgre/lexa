import type { AssistantProvider } from "../../../shared/assistant";

// Pure logic for the workspace Assistant provider registry section.

export function providerBaseUrl(p: AssistantProvider | null): string {
  return (p?.baseUrl ?? (p as unknown as { base_url?: string } | null)?.base_url) ?? "";
}

export type ProviderFormState = { label: string; baseUrl: string; apiKey: string };

// Quick-fill presets (wireframe admin-assistant-providers.html): they write
// Label + Base URL only — the key stays operator-entered, write-only. The
// active mark is derived, not stored: it is set only while BOTH fields match a
// preset exactly, so editing either field by hand clears it.
export interface ProviderPreset {
  label: string;
  baseUrl: string;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  { label: "Cloudflare AI", baseUrl: "https://api.cloudflare.com/client/v4/accounts/<account_id>/ai/v1" },
  { label: "OpenCode Zen", baseUrl: "https://opencode.ai/zen/v1" },
  { label: "OpenCode Go", baseUrl: "https://opencode.ai/zen/go/v1" },
];

export function activePreset(label: string, baseUrl: string): ProviderPreset | null {
  return PROVIDER_PRESETS.find((p) => p.label === label && p.baseUrl === baseUrl) ?? null;
}

// Edit keeps the stored key unless a new one is typed; a key-less create is
// legal and deliberate, so an empty apiKey simply omits the field.
export function providerFormPayload(state: ProviderFormState): { label: string; baseUrl: string; apiKey?: string } | null {
  const label = state.label.trim();
  const baseUrl = state.baseUrl.trim();
  if (!label || !baseUrl) return null;
  if (state.apiKey.trim()) return { label, baseUrl, apiKey: state.apiKey.trim() };
  return { label, baseUrl };
}
