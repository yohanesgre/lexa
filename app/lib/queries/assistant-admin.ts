import { useQuery, useQueries, useMutation, useQueryClient } from "@tanstack/react-query";
import type { AssistantProvider, AssistantProviderModel } from "../../../shared/assistant";
import * as api from "../api";
import { useToast } from "../../components/ui/Toast";

function toastMessage(err: unknown): string {
  const e = err as { code?: string | undefined; message?: string };
  return e.message || "Something went wrong";
}

export function useAssistantProviders() {
  return useQuery({
    queryKey: ["assistant-providers"],
    queryFn: () => api.listAssistantProviders().then((r) => r.data),
    retry: false,
    staleTime: 30_000,
  });
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
    onError: (err) => {
      toast.push("error", "Probe failed", toastMessage(err));
    },
  });
}

export function useCreateProvider() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (input: { label: string; baseUrl: string; apiKey: string }) => api.createAssistantProvider(input),
    onSuccess: (provider) => {
      qc.setQueryData<AssistantProvider[]>(["assistant-providers"], (old) => (old ? [...old, provider] : [provider]));
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
    mutationFn: ({ id, ...input }: { id: string; label?: string | undefined; baseUrl?: string | undefined; apiKey?: string }) => api.updateAssistantProvider(id, input),
    onSuccess: (provider) => {
      qc.setQueryData<AssistantProvider[]>(["assistant-providers"], (old) => (old ?? []).map((p) => (p.id === provider.id ? provider : p)));
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
      qc.setQueryData<AssistantProvider[]>(["assistant-providers"], (old) => (old ?? []).filter((p) => p.id !== id));
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
      qc.setQueryData<AssistantProvider[]>(["assistant-providers"], (old) => {
        if (!old) return old;
        const nextModels = (res.data ?? []) as unknown as AssistantProviderModel[];
        return old.map((p) => (p.id === id ? { ...p, models: nextModels } : p));
      });
      toast.push("success", "Models fetched");
    },
    onError: (err) => {
      toast.push("error", "Failed to fetch models", toastMessage(err));
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

export function useUpdateProviderModel(providerId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ modelId, ...patch }: { modelId: string; enabled?: boolean | undefined; priority?: number }) =>
      api.updateAssistantProviderModel(providerId, modelId, patch),
    onSuccess: (model) => {
      qc.setQueryData<AssistantProvider[]>(["assistant-providers"], (old) => {
        if (!old) return old;
        return old.map((p) => {
          if (p.id !== providerId) return p;
          const models = (p.models ?? []).map((m) => (m.modelId === model.modelId || m.id === model.id ? model as unknown as AssistantProviderModel : m));
          return { ...p, models };
        });
      });
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
      qc.setQueryData<AssistantProvider[]>(["assistant-providers"], (old) => {
        if (!old) return old;
        return old.map((p) => (p.id === vars.providerId ? { ...p, models: nextModels } : p));
      });
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
