import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export interface AssistantUsageFilters {
  from?: string | null | undefined;
  to?: string | null | undefined;
  projectId?: string | null | undefined;
}

export interface AssistantUsageSummary {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  totalCostCents: number;
  totalCostUsd: number;
  avgLatencyMs: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  errorRate: number;
  totalCalls: number;
  errorCalls: number;
}

export interface AssistantByDayRow {
  day: string;
  tokens: number;
  costCents: number;
  costUsd: number;
  avgLatencyMs: number | null;
  calls: number;
  errorRate: number;
}

export interface AssistantByModelRow {
  model: string;
  tokens: number;
  costCents: number;
  costUsd: number;
  avgLatencyMs: number | null;
  calls: number;
  errorRate: number;
}

export interface AssistantUsageResponse {
  summary: AssistantUsageSummary;
  totalCostCents: number;
  byDay: AssistantByDayRow[];
  byModel: AssistantByModelRow[];
}

export interface AssistantPriceRow {
  model: string;
  prompt_price: number;
  completion_price: number;
  cached_read_price: number;
  cached_write_price: number;
  updated_at: string;
}

function buildQuery(filters: AssistantUsageFilters): string {
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
    const body = await res.json().catch(() => ({})) as { error?: { code?: string | undefined; message?: string } };
    const err = new Error(body.error?.message ?? `HTTP ${res.status}`) as Error & { code?: string };
    err.code = body.error?.code!;
    throw err;
  }
  return res.json() as Promise<T>;
}

export function useAssistantUsage(filters: AssistantUsageFilters) {
  return useQuery({
    queryKey: ["assistant-usage", filters.from ?? null, filters.to ?? null, filters.projectId ?? null],
    queryFn: () => requestJson<AssistantUsageResponse>(`/api/admin/assistant/usage${buildQuery(filters)}`),
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

export function useProjectAssistantUsage(slug: string, filters: Omit<AssistantUsageFilters, "projectId">) {
  return useQuery({
    queryKey: ["assistant-usage-project", slug, filters.from ?? null, filters.to ?? null],
    queryFn: () => requestJson<AssistantUsageResponse>(`/api/projects/${encodeURIComponent(slug)}/assistant/usage${buildQuery(filters as AssistantUsageFilters)}`),
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    enabled: !!slug,
  });
}

export async function exportAssistantUsageCsv(filters: AssistantUsageFilters): Promise<void> {
  const res = await fetch(`/api/admin/assistant/usage.csv${buildQuery(filters)}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "assistant-usage.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function useAssistantPrices() {
  return useQuery({
    queryKey: ["assistant-prices"],
    queryFn: () => requestJson<{ data: AssistantPriceRow[] }>(`/api/admin/assistant/prices`),
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

export function usePutAssistantPrice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { model: string; prompt_price: number; completion_price: number; cached_read_price: number; cached_write_price: number }) =>
      requestJson<AssistantPriceRow>(`/api/admin/assistant/prices`, {
        method: "PUT",
        body: JSON.stringify(input),
      }),
    onSuccess: (row) => {
      qc.setQueryData<{ data: AssistantPriceRow[] }>(["assistant-prices"], (old) => {
        const rows = old?.data ?? [];
        const idx = rows.findIndex((r) => r.model === row.model);
        const next = idx === -1 ? [...rows, row] : rows.map((r, i) => (i === idx ? row : r));
        return { data: next };
      });
    },
  });
}
