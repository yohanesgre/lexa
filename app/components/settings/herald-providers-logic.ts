import type { HeraldProvider } from "../../../shared/herald";

// Pure logic for the workspace Herald provider registry section.

export function providerBaseUrl(p: HeraldProvider | null): string {
  return (p?.baseUrl ?? (p as unknown as { base_url?: string } | null)?.base_url) ?? "";
}

export type ProviderFormState = { label: string; baseUrl: string; apiKey: string };

// Edit keeps the stored key unless a new one is typed; create requires one.
export function providerFormPayload(state: ProviderFormState): { label: string; baseUrl: string; apiKey?: string } | null {
  const label = state.label.trim();
  const baseUrl = state.baseUrl.trim();
  if (!label || !baseUrl) return null;
  if (state.apiKey.trim()) return { label, baseUrl, apiKey: state.apiKey.trim() };
  return { label, baseUrl };
}

export function canSubmitProviderForm(state: ProviderFormState, editing: boolean): boolean {
  return !!state.label.trim() && !!state.baseUrl.trim() && (editing || !!state.apiKey.trim());
}
