import { useQuery, useQueries, useMutation, useQueryClient } from "@tanstack/react-query";
import type { AssistantProvider, AssistantProviderModel } from "../../../shared/assistant";
import * as api from "../api";
import { useToast } from "../../components/ui/Toast";

function toastMessage(err: unknown): string {
  const e = err as { code?: string | undefined; message?: string };
  return e.message || "Something went wrong";
}

// The registry cache holds the whole list BODY, not just the rows, because the
// body also carries `secretsEnabled` — the server's real capability for managed
// provider keys. The section reads both from one query, so the flag can never
// disagree with the rows it describes.
type ProviderList = { data: AssistantProvider[]; secretsEnabled: boolean | undefined };

function providersQuery() {
  return {
    queryKey: ["assistant-providers"] as const,
    queryFn: (): Promise<ProviderList> => api.listAssistantProviders(),
    retry: false,
    staleTime: 30_000,
  };
}

export function useAssistantProviders() {
  const query = useQuery(providersQuery());
  // Rows stay the hook's `data` for existing callers; the capability rides
  // alongside. `undefined` while the list is in flight — the caller must treat
  // that as "capability not known yet", never as "off".
  return { ...query, data: query.data?.data, secretsEnabled: query.data?.secretsEnabled };
}

// Mutations write the list body, preserving the capability from the old entry.
// A cold cache leaves it `undefined` — unknown, never a fabricated `false`,
// which the UI would render as a definitive "key storage is off".
function withProvider(
  old: ProviderList | undefined,
  next: (rows: AssistantProvider[]) => AssistantProvider[]
): ProviderList {
  return { data: next(old?.data ?? []), secretsEnabled: old?.secretsEnabled };
}

export function useAssistantProvidersHealth(providerIds: string[]) {
  return useQueries({
    queries: providerIds.map((id) => ({
      queryKey: ["assistant-provider-health", id],
      queryFn: () => api.getAssistantProviderHealth(id),
      retry: false,
      staleTime: 30_000,
      refetchInterval: 30_000,
      refetchOnWindowFocus: false,
    })),
  });
}

export function useProbeAssistantProvider() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (id: string) => api.probeAssistantProvider(id),
    onSuccess: (row) => {
      qc.setQueryData(["assistant-provider-health", row.providerId], row);
      if (row.circuitState === "closed") toast.push("success", "Probe succeeded — breaker closed");
      else toast.push("warning", `Probe finished — breaker ${row.circuitState}`);
    },
  });
}

export function useCreateProvider() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (input: { label: string; baseUrl: string; apiKey: string }) => api.createAssistantProvider(input),
    onSuccess: (provider) => {
      qc.setQueryData<ProviderList>(["assistant-providers"], (old) => withProvider(old, (rows) => [...rows, provider]));
      toast.push("success", "Provider created");
    },
    onError: (err) => {
      toast.push("error", "Failed to create provider", toastMessage(err));
    },
  });
}

export function useUpdateProvider() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string; label?: string | undefined; baseUrl?: string | undefined; apiKey?: string | undefined; clearKey?: boolean | undefined }) => api.updateAssistantProvider(id, input),
    onSuccess: (provider) => {
      qc.setQueryData<ProviderList>(["assistant-providers"], (old) => withProvider(old, (rows) => rows.map((p) => (p.id === provider.id ? provider : p))));
      toast.push("success", "Provider updated");
    },
    onError: (err) => {
      toast.push("error", "Failed to update provider", toastMessage(err));
    },
  });
}

export function useDeleteProvider() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (id: string) => api.deleteAssistantProvider(id),
    onSuccess: (_v, id) => {
      qc.setQueryData<ProviderList>(["assistant-providers"], (old) => withProvider(old, (rows) => rows.filter((p) => p.id !== id)));
      toast.push("success", "Provider deleted");
    },
    onError: (err) => {
      toast.push("error", "Failed to delete provider", toastMessage(err));
    },
  });
}

export function useTestProvider() {
  const toast = useToast();
  return useMutation({
    mutationFn: (id: string) => api.testAssistantProvider(id),
    onError: (err) => {
      const code = (err as { code?: string }).code;
      if (code === "PROVIDER_AUTH_FAILED" || code === "PROVIDER_UNREACHABLE") return;
      toast.push("error", "Test failed", toastMessage(err));
    },
  });
}

export function useFetchModels() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (id: string) => api.fetchAssistantProviderModels(id),
    onSuccess: (res, id) => {
      qc.setQueryData<ProviderList>(["assistant-providers"], (old) => withProvider(old, (rows) => {
        const nextModels = (res.data ?? []) as unknown as AssistantProviderModel[];
        return rows.map((p) => (p.id === id ? { ...p, models: nextModels } : p));
      }));
      toast.push("success", "Models fetched");
    },
    onError: (err) => {
      toast.push("error", "Failed to fetch models", toastMessage(err));
    },
  });
}

// ── MCP clients ──

// The registry cache holds the WHOLE list body, not just the rows, because the
// body also carries `managedSecretsEnabled` — the server's real capability for
// managed tokens. Both hooks below read the same key, so the flag costs no extra
// request and can never disagree with the rows it describes.
const MCP_SERVERS_KEY = ["assistant-mcp-servers"] as const;
type McpServerList = { data: api.McpServer[]; managedSecretsEnabled: boolean | undefined };

function mcpServersQuery() {
  return {
    queryKey: MCP_SERVERS_KEY,
    queryFn: (): Promise<McpServerList> => api.listMcpServers(),
    retry: false,
    staleTime: 30_000,
  };
}

export function useMcpServers() {
  return useQuery({ ...mcpServersQuery(), select: (r) => r.data });
}

// `undefined` while the list is in flight — the caller must treat that as
// "capability not known yet", never as "off".
export function useMcpManagedSecrets() {
  return useQuery({ ...mcpServersQuery(), select: (r) => r.managedSecretsEnabled });
}

// Mutations write the list body, preserving the capability from the old entry.
// A cold cache leaves the capability `undefined` — unknown, never a fabricated
// `false`, which the UI would render as a definitive "managed tokens are off".
// A mounted list query is in flight in that case and overwrites the entry with
// the server's truth as soon as it resolves.
function withServer(
  old: McpServerList | undefined,
  next: (rows: api.McpServer[]) => api.McpServer[]
): McpServerList {
  return { data: next(old?.data ?? []), managedSecretsEnabled: old?.managedSecretsEnabled };
}

export function useCreateMcpServer() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (input: api.McpServerInput) => api.createMcpServer(input),
    onSuccess: (server) => {
      qc.setQueryData<McpServerList>(MCP_SERVERS_KEY, (old) => withServer(old, (rows) => [...rows, server]));
      toast.push("success", "MCP client created");
    },
    onError: (err) => {
      toast.push("error", "Failed to create MCP client", toastMessage(err));
    },
  });
}

export function useUpdateMcpServer() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string } & api.McpServerPatch) => api.updateMcpServer(id, input),
    onSuccess: (server) => {
      qc.setQueryData<McpServerList>(MCP_SERVERS_KEY, (old) => withServer(old, (rows) => rows.map((s) => (s.id === server.id ? server : s))));
      toast.push("success", "MCP client updated");
    },
    onError: (err) => {
      toast.push("error", "Failed to update MCP client", toastMessage(err));
    },
  });
}

export function useDeleteMcpServer() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (id: string) => api.deleteMcpServer(id),
    onSuccess: (_v, id) => {
      qc.setQueryData<McpServerList>(MCP_SERVERS_KEY, (old) => withServer(old, (rows) => rows.filter((s) => s.id !== id)));
      toast.push("success", "MCP client deleted");
    },
    onError: (err) => {
      toast.push("error", "Failed to delete MCP client", toastMessage(err));
    },
  });
}

// Test result is a report body (HTTP 200 even on a failed connect) — only an
// unknown id / transport failure reaches onError. Never persists counts.
export function useTestMcpServer() {
  const toast = useToast();
  return useMutation({
    mutationFn: (id: string) => api.testMcpServer(id),
    onError: (err) => {
      const code = (err as { code?: string }).code;
      if (code === "MCP_SERVER_NOT_FOUND") return;
      toast.push("error", "Test failed", toastMessage(err));
    },
  });
}

export function useProjectMcpServers(projectId: string | undefined) {
  return useQuery({
    queryKey: ["project-mcp-servers", projectId],
    queryFn: () => api.listProjectMcpServers(projectId!).then((r) => r.data),
    enabled: !!projectId,
    retry: false,
    staleTime: 30_000,
  });
}

export function useSetProjectMcpServers(projectId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (entries: Array<{ serverId: string; enabled: boolean }>) => api.putProjectMcpServers(projectId, entries),
    onSuccess: (res) => {
      qc.setQueryData<api.McpProjectServer[]>(["project-mcp-servers", projectId], res.data);
    },
    onError: (err) => {
      toast.push("error", "Failed to update project MCP clients", toastMessage(err));
    },
  });
}

// ── Jev advisory registry ──

// The cache holds the whole GET body (`{ config, secretsEnabled }`): the
// section renders the key-storage warning from the same read that produced the
// config, so the two can never disagree.
export function useAssistantJevConfig() {
  return useQuery({
    queryKey: ["assistant-jev"],
    queryFn: () => api.getAssistantJevConfig(),
    retry: false,
    staleTime: 30_000,
  });
}

export function useUpdateAssistantJevConfig() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (input: api.AssistantJevPatch) => api.updateAssistantJevConfig(input),
    onSuccess: (res) => {
      qc.setQueryData(["assistant-jev"], res);
      toast.push("success", "Jev configuration saved");
    },
    onError: (err) => {
      toast.push("error", "Failed to save Jev configuration", toastMessage(err));
    },
  });
}

// Expected Jev test failures (auth / unreachable / invalid config / no key) are
// outcomes the section renders from the error body — only unexpected failures
// toast.
export function useTestAssistantJev() {
  const toast = useToast();
  return useMutation({
    mutationFn: () => api.testAssistantJev(),
    onError: (err) => {
      const code = (err as { code?: string }).code;
      if (code === "JEV_AUTH_FAILED" || code === "JEV_UNREACHABLE" || code === "JEV_INVALID_CONFIG" || code === "SECRET_KEY_UNAVAILABLE") return;
      toast.push("error", "Test failed", toastMessage(err));
    },
  });
}

export function useProjectJev(projectId: string | undefined) {
  return useQuery({
    queryKey: ["project-jev", projectId],
    queryFn: () => api.getProjectJev(projectId!),
    enabled: !!projectId,
    retry: false,
    staleTime: 30_000,
  });
}

export function useSetProjectJev(projectId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (input: { enabled: boolean }) => api.putProjectJev(projectId, input),
    onSuccess: (res) => {
      qc.setQueryData(["project-jev", projectId], res);
    },
    onError: (err) => {
      toast.push("error", "Failed to update Jev advisory", toastMessage(err));
    },
  });
}

export { useAssistantUsage } from "../assistant-usage.query";

export function useAssistantCalls(params?: { projectId?: string | undefined; limit?: number }) {
  return useQuery({
    queryKey: ["assistant-calls", params?.projectId ?? null, params?.limit ?? null],
    queryFn: () => api.listAssistantCalls(params).then((r) => r.data),
    retry: false,
    staleTime: 30_000,
  });
}

export function useAssistantRuns(params: {
  status?: string | null;
  projectId?: string | null;
  limit?: number;
  cursor?: string | null;
}) {
  return useQuery({
    queryKey: ["assistant-runs", params.status ?? null, params.projectId ?? null, params.limit ?? null, params.cursor ?? null],
    queryFn: () =>
      api.listAssistantRuns({
        status: params.status ?? undefined,
        projectId: params.projectId ?? undefined,
        limit: params.limit,
        cursor: params.cursor ?? undefined,
      }),
    retry: false,
    staleTime: 15_000,
  });
}

export function useAssistantBindings() {
  return useQuery({
    queryKey: ["assistant-bindings"],
    queryFn: () => api.listAssistantBindings().then((r) => r.data),
    retry: false,
    staleTime: 30_000,
  });
}

export function useSyncPrices() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: () => api.syncAssistantPrices(),
    onSuccess: (res) => {
      qc.setQueryData<{ data: typeof res.data }>(["assistant-prices"], { data: res.data });
      toast.push("success", res.synced > 0 ? `Synced ${res.synced} prices` : "Prices are up to date");
    },
    onError: (err) => {
      toast.push("error", "Failed to sync prices", toastMessage(err));
    },
  });
}

export function useUpdateProviderModel(providerId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ modelId, ...patch }: { modelId: string; enabled?: boolean | undefined; priority?: number }) =>
      api.updateAssistantProviderModel(providerId, modelId, patch),
    onSuccess: (model) => {
      qc.setQueryData<ProviderList>(["assistant-providers"], (old) => withProvider(old, (rows) => rows.map((p) => {
        if (p.id !== providerId) return p;
        const models = (p.models ?? []).map((m) => (m.modelId === model.modelId || m.id === model.id ? model as unknown as AssistantProviderModel : m));
        return { ...p, models };
      })));
    },
    onError: (err) => {
      toast.push("error", "Failed to update model", toastMessage(err));
    },
  });
}

export function useReorderProviderModels() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ providerId, orderedIds }: { providerId: string; orderedIds: string[] }) =>
      api.reorderAssistantProviderModels(providerId, orderedIds),
    onSuccess: (res, vars) => {
      const nextModels = (res.data ?? []) as unknown as AssistantProviderModel[];
      qc.setQueryData<ProviderList>(["assistant-providers"], (old) => withProvider(old, (rows) => rows.map((p) => (p.id === vars.providerId ? { ...p, models: nextModels } : p))));
    },
    onError: (err) => {
      toast.push("error", "Failed to reorder models", toastMessage(err));
    },
  });
}

export function useAssistantProjectSettings(projectId: string | undefined) {
  return useQuery({
    queryKey: ["assistant-settings", projectId],
    queryFn: async () => {
      try {
        return await api.getAssistantProjectSettings(projectId!);
      } catch (err) {
        if ((err as { code?: string }).code === "PROVIDER_NOT_CONFIGURED") return null;
        throw err;
      }
    },
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

export function useSaveAssistantProjectSettings(projectId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (input: { providerId: string | null; modelId: string | null; fallbackModelIds: string[] }) =>
      api.putAssistantProjectSettings(projectId, input),
    onSuccess: (settings) => {
      qc.setQueryData(["assistant-settings", projectId], settings);
      toast.push("success", "Assistant provider saved");
    },
    onError: (err) => {
      toast.push("error", "Failed to save Assistant provider", toastMessage(err));
    },
  });
}

export function useTestAssistantProjectSettings(projectId: string) {
  const toast = useToast();
  return useMutation({
    mutationFn: (input: { providerId: string | null; modelId: string | null }) =>
      api.testAssistantSettings(projectId, { kind: "openai_compatible", baseUrl: "", model: input.modelId ?? "" } as never),
    onError: (err) => {
      if (!toastMessage(err).includes("PROVIDER_")) toast.push("error", "Test failed", toastMessage(err));
    },
  });
}
