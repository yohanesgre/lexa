import type { AssistantProvider } from "../../../shared/assistant";

// Pure logic for the workspace Assistant provider registry section.

export function providerBaseUrl(p: AssistantProvider | null): string {
  return (p?.baseUrl ?? (p as unknown as { base_url?: string } | null)?.base_url) ?? "";
}

export type ProviderFormState = { label: string; baseUrl: string; apiKey: string };

// Edit keeps the stored key unless a new one is typed; a key-less create is
// legal and deliberate, so an empty apiKey simply omits the field.
export function providerFormPayload(state: ProviderFormState): { label: string; baseUrl: string; apiKey?: string } | null {
  const label = state.label.trim();
  const baseUrl = state.baseUrl.trim();
  if (!label || !baseUrl) return null;
  if (state.apiKey.trim()) return { label, baseUrl, apiKey: state.apiKey.trim() };
  return { label, baseUrl };
}
