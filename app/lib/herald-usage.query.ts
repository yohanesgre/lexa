import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export interface HeraldUsageFilters {
  from?: string | null;
  to?: string | null;
  projectId?: string | null;
}

export interface HeraldUsageSummary {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  totalCostCents: number;
  totalCostUsd: number;
  avgLatencyMs: number | null;
  errorRate: number;
  totalCalls: number;
  errorCalls: number;
}

export interface HeraldByDayRow {
  day: string;
  tokens: number;
  costCents: number;
  costUsd: number;
  avgLatencyMs: number | null;
  calls: number;
  errorRate: number;
}

export interface HeraldByModelRow {
  model: string;
  tokens: number;
  costCents: number;
  costUsd: number;
  avgLatencyMs: number | null;
  calls: number;
  errorRate: number;
}

export interface HeraldUsageResponse {
  summary: HeraldUsageSummary;
  totalCostCents: number;
  byDay: HeraldByDayRow[];
  byModel: HeraldByModelRow[];
}

export interface HeraldPriceRow {
  model: string;
  prompt_price: number;
  completion_price: number;
  updated_at: string;
}

function buildQuery(filters: HeraldUsageFilters): string {
  const qs = new URLSearchParams();
  if (filters.from) qs.set("from", filters.from);
  if (filters.to) qs.set("to", filters.to);
  if (filters.projectId) qs.set("projectId", filters.projectId);
  const q = qs.toString();
  return q ? `?${q}` : "";
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers as Record<string, string> | undefined) } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
    const err = new Error(body.error?.message ?? `HTTP ${res.status}`) as Error & { code?: string };
    err.code = body.error?.code;
    throw err;
  }
  return res.json() as Promise<T>;
}

export function useHeraldUsage(filters: HeraldUsageFilters) {
  return useQuery({
    queryKey: ["herald-usage", filters.from ?? null, filters.to ?? null, filters.projectId ?? null],
    queryFn: () => requestJson<HeraldUsageResponse>(`/api/admin/herald/usage${buildQuery(filters)}`),
    retry: false,
    staleTime: 30_000,
  });
}

export function useProjectHeraldUsage(slug: string, filters: Omit<HeraldUsageFilters, "projectId">) {
  return useQuery({
    queryKey: ["herald-usage-project", slug, filters.from ?? null, filters.to ?? null],
    queryFn: () => requestJson<HeraldUsageResponse>(`/api/projects/${encodeURIComponent(slug)}/herald/usage${buildQuery(filters as HeraldUsageFilters)}`),
    retry: false,
    staleTime: 30_000,
    enabled: !!slug,
  });
}

export async function exportHeraldUsageCsv(filters: HeraldUsageFilters): Promise<void> {
  const res = await fetch(`/api/admin/herald/usage.csv${buildQuery(filters)}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "herald-usage.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function useHeraldPrices() {
  return useQuery({
    queryKey: ["herald-prices"],
    queryFn: () => requestJson<{ data: HeraldPriceRow[] }>(`/api/admin/herald/prices`),
    retry: false,
    staleTime: 30_000,
  });
}

export function usePutHeraldPrice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { model: string; prompt_price: number; completion_price: number }) =>
      requestJson<HeraldPriceRow>(`/api/admin/herald/prices`, {
        method: "PUT",
        body: JSON.stringify(input),
      }),
    onSuccess: (row) => {
      qc.setQueryData<HeraldPriceRow[]>(["herald-prices"], (old) => {
        if (!old) return [row];
        const idx = old.findIndex((r) => r.model === row.model);
        if (idx === -1) return [...old, row];
        const next = [...old];
        next[idx] = row;
        return next;
      });
      qc.invalidateQueries({ queryKey: ["herald-usage"] });
      qc.invalidateQueries({ queryKey: ["herald-usage-project"] });
    },
  });
}
