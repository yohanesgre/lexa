import type { HeraldProviderModel } from "../../../shared/herald";

// Pure logic for herald-project.tsx (Project Settings → Herald provider):
// model/fallback list algebra, hydration & default settling, connection test.

export type ProviderLike = { id: string; label: string; baseUrl?: string | undefined; models?: HeraldProviderModel[] | undefined };

export type EnabledModel = HeraldProviderModel & { providerLabel: string; providerId: string; baseUrl: string };

function providerBaseUrl(p: ProviderLike): string {
  return (p.baseUrl ?? (p as unknown as { base_url?: string }).base_url) ?? "";
}

export function providerOptionLabel(p: ProviderLike): string {
  const count = (p.models ?? []).filter((m) => m.enabled).length;
  return `${p.label} — ${providerBaseUrl(p)} (${count} enabled)`;
}

export function enabledModelsOf(provider: ProviderLike | undefined): HeraldProviderModel[] {
  if (!provider?.models) return [];
  return provider.models.filter((m) => m.enabled).sort((a, b) => a.priority - b.priority);
}

export function enabledModelsAcross(providers: ProviderLike[]): EnabledModel[] {
  const out: EnabledModel[] = [];
  for (const p of providers) {
    for (const m of p.models ?? []) {
      if (m.enabled) out.push({ ...m, providerLabel: p.label, providerId: p.id, baseUrl: providerBaseUrl(p) });
    }
  }
  return out;
}

export function primaryKeyOf(providerId: string, modelId: string): string | null {
  return providerId && modelId ? `${providerId}:${modelId}` : null;
}

export function fallbackRowsFor(fallbacks: string[], all: EnabledModel[]): Array<HeraldProviderModel & { providerLabel: string; providerId: string }> {
  const byModel = new Map<string, EnabledModel>();
  const byKey = new Map<string, EnabledModel>();
  for (const m of all) {
    if (!byModel.has(m.modelId)) byModel.set(m.modelId, m);
    if (!byKey.has(`${m.providerId}:${m.modelId}`)) byKey.set(`${m.providerId}:${m.modelId}`, m);
  }
  const rows = [];
  for (const fid of fallbacks) {
    const sep = fid.indexOf(":");
    const match = sep >= 0 ? byKey.get(`${fid.slice(0, sep)}:${fid.slice(sep + 1)}`) : byModel.get(fid);
    if (match) rows.push(match);
  }
  return rows;
}

export function fallbackOptionsFor(all: EnabledModel[], primaryKey: string | null, fallbacks: string[]): EnabledModel[] {
  const fallbackKeySet = new Set(fallbacks);
  return all.filter((m) => {
    const key = `${m.providerId}:${m.modelId}`;
    if (primaryKey && key === primaryKey) return false;
    if (fallbackKeySet.has(key)) return false;
    if (fallbackKeySet.has(m.modelId)) return false;
    return true;
  });
}

export function moveFallback(fallbacks: string[], idx: number, dir: -1 | 1): string[] {
  const next = [...fallbacks];
  const target = idx + dir;
  if (target < 0 || target >= next.length) return fallbacks;
  const tmp = next[idx]!;
  next[idx] = next[target]!;
  next[target] = tmp;
  return next;
}

export function canAddFallback(fallbacks: string[], addFallbackId: string, primaryKey: string | null, modelId: string): boolean {
  if (!addFallbackId) return false;
  if (fallbacks.includes(addFallbackId)) return false;
  if (primaryKey && addFallbackId === primaryKey) return false;
  if (addFallbackId === modelId) return false;
  return true;
}

// Provider select: keep the picked model when it still exists on the new
// provider; otherwise snap to the first enabled model (or clear), and drop
// fallbacks that now equal the primary.
export function onProviderChange(providers: ProviderLike[], pid: string, modelId: string, fallbacks: string[]): { modelId: string; fallbacks: string[] } {
  const enabled = enabledModelsOf(providers.find((p) => p.id === pid));
  let nextModelId = modelId;
  if (enabled.length && !enabled.some((m) => m.modelId === modelId)) nextModelId = enabled[0]!.modelId;
  else if (!enabled.length) nextModelId = "";
  return { modelId: nextModelId, fallbacks: filterPrimaryFallbacks(fallbacks, primaryKeyOf(pid, nextModelId), nextModelId) };
}

export function onModelChange(providerId: string, nextModelId: string, fallbacks: string[]): string[] {
  return filterPrimaryFallbacks(fallbacks, primaryKeyOf(providerId, nextModelId), nextModelId);
}

function filterPrimaryFallbacks(fallbacks: string[], primaryKey: string | null, modelId: string): string[] {
  return fallbacks.filter((fid) => {
    if (primaryKey && fid === primaryKey) return false;
    return fid !== modelId;
  });
}

// Default fallback suggestions: up to 2 enabled models (priority order)
// from the primary provider, excluding the primary model itself.
function suggestFallbacks(providers: ProviderLike[], providerId: string, modelId: string): string[] {
  const prov = providers.find((p) => p.id === providerId);
  const enabled = enabledModelsOf(prov);
  if (enabled.length < 2) return [];
  return enabled.filter((m) => m.modelId !== modelId).slice(0, 2).map((m) => `${providerId}:${m.modelId}`);
}

// First provider with any enabled model → the initial primary choice plus
// its fallback suggestions.
export function initialModelChoice(providers: ProviderLike[]): { providerId: string; modelId: string; fallbacks: string[] } | null {
  const firstWithModels = providers.find((p) => (p.models ?? []).some((m) => m.enabled));
  if (!firstWithModels) return null;
  const enabled = enabledModelsOf(firstWithModels);
  if (enabled.length === 0) return null;
  const modelId = enabled[0]!.modelId;
  return {
    providerId: firstWithModels.id,
    modelId,
    fallbacks: enabled.filter((m) => m.modelId !== modelId).slice(0, 2).map((m) => `${firstWithModels.id}:${m.modelId}`),
  };
}

export type ProjectModelState = { providerId: string; modelId: string; fallbacks: string[] };

// Hydration: apply fetched settings once, or mark settled when both the
// project and legacy settings are confirmed null (nothing to hydrate).
export function hydrateStep(args: {
  settings: { providerId?: string | null | undefined; modelId?: string | null | undefined; fallbackModelIds?: string[] } | null | undefined;
  legacySettings: unknown;
  settingsLoading: boolean;
}): { patch?: ProjectModelState; settled: boolean } {
  const { settings, legacySettings, settingsLoading } = args;
  if (settings && (settings.providerId !== undefined || settings.modelId !== undefined)) {
    return {
      patch: { providerId: settings.providerId ?? "", modelId: settings.modelId ?? "", fallbacks: settings.fallbackModelIds ?? [] },
      settled: true,
    };
  }
  if (settings === null && legacySettings === null && !settingsLoading) return { settled: true };
  return { settled: false };
}

// Default settling: pick a primary when none selected, then suggest
// fallbacks for a chosen primary until the user edits them.
export function defaultsStep(providers: ProviderLike[], providerId: string, modelId: string, fallbackCount: number): { primary?: { providerId: string; modelId: string; fallbacks: string[] }; fallbacks?: string[] } {
  if (!providerId) {
    const choice = initialModelChoice(providers);
    return choice ? { primary: choice } : {};
  }
  if (!modelId || fallbackCount > 0) return {};
  const fallbacks = suggestFallbacks(providers, providerId, modelId);
  return fallbacks.length > 0 ? { fallbacks } : {};
}

export type ConnectionTestResult = { ok: true; latencyMs: number } | { ok: false; code: string; msg: string };

export function savePayload(providerId: string, modelId: string, fallbacks: string[]): { providerId: string | null; modelId: string | null; fallbackModelIds: string[] } {
  return { providerId: providerId || null, modelId: modelId || null, fallbackModelIds: fallbacks };
}

export function hasPrimary(providerId: string, modelId: string): boolean {
  return providerId !== "" && modelId !== "";
}

export async function testConnection(projectId: string, body: { providerId: string | null; modelId: string | null; fallbackModelIds: string[] }): Promise<ConnectionTestResult> {
  try {
    const res = await fetch(`/api/herald/settings/${projectId}/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
      return {
        ok: false,
        code: err.error?.code ?? "PROVIDER_UNREACHABLE",
        msg: (err.error?.message ?? "").slice(0, 500) || "Upstream rejected the key (401). Other outcome: PROVIDER_UNREACHABLE.",
      };
    }
    const data = (await res.json().catch(() => ({}))) as { latencyMs?: number };
    return { ok: true, latencyMs: data.latencyMs ?? 0 };
  } catch {
    return { ok: false, code: "PROVIDER_UNREACHABLE", msg: "Upstream unreachable" };
  }
}
