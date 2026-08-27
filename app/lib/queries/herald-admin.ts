import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { HeraldProvider, HeraldProviderModel } from "../../../shared/herald";
import * as api from "../api";
import { useToast } from "../../components/ui/Toast";

function toastMessage(err: unknown): string {
  const e = err as { code?: string | undefined; message?: string };
  return e.message || "Something went wrong";
}

export function useHeraldProviders() {
  return useQuery({
    queryKey: ["herald-providers"],
    queryFn: () => api.listHeraldProviders().then((r) => r.data),
    retry: false,
    staleTime: 30_000,
  });
}

export function useCreateProvider() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (input: { label: string; baseUrl: string; apiKey: string }) => api.createHeraldProvider(input),
    onSuccess: (provider) => {
      qc.setQueryData<HeraldProvider[]>(["herald-providers"], (old) => (old ? [...old, provider] : [provider]));
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
    mutationFn: ({ id, ...input }: { id: string; label?: string | undefined; baseUrl?: string | undefined; apiKey?: string }) => api.updateHeraldProvider(id, input),
    onSuccess: (provider) => {
      qc.setQueryData<HeraldProvider[]>(["herald-providers"], (old) => (old ?? []).map((p) => (p.id === provider.id ? provider : p)));
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
    mutationFn: (id: string) => api.deleteHeraldProvider(id),
    onSuccess: (_v, id) => {
      qc.setQueryData<HeraldProvider[]>(["herald-providers"], (old) => (old ?? []).filter((p) => p.id !== id));
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
    mutationFn: (id: string) => api.testHeraldProvider(id),
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
    mutationFn: (id: string) => api.fetchHeraldProviderModels(id),
    onSuccess: (res, id) => {
      qc.setQueryData<HeraldProvider[]>(["herald-providers"], (old) => {
        if (!old) return old;
        const nextModels = (res.data ?? []) as unknown as HeraldProviderModel[];
        return old.map((p) => (p.id === id ? { ...p, models: nextModels } : p));
      });
      toast.push("success", "Models fetched");
    },
    onError: (err) => {
      toast.push("error", "Failed to fetch models", toastMessage(err));
    },
  });
}

export function useHeraldUsage() {
  return useQuery({
    queryKey: ["herald-usage"],
    queryFn: () => api.getHeraldUsage(),
    retry: false,
    staleTime: 60_000,
  });
}

export function useHeraldCalls(params?: { projectId?: string | undefined; limit?: number }) {
  return useQuery({
    queryKey: ["herald-calls", params?.projectId ?? null, params?.limit ?? null],
    queryFn: () => api.listHeraldCalls(params).then((r) => r.data),
    retry: false,
    staleTime: 30_000,
  });
}

export function useUpdateProviderModel(providerId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ modelId, ...patch }: { modelId: string; enabled?: boolean | undefined; priority?: number }) =>
      api.updateHeraldProviderModel(providerId, modelId, patch),
    onSuccess: (model) => {
      qc.setQueryData<HeraldProvider[]>(["herald-providers"], (old) => {
        if (!old) return old;
        return old.map((p) => {
          if (p.id !== providerId) return p;
          const models = (p.models ?? []).map((m) => (m.modelId === model.modelId || m.id === model.id ? model as unknown as HeraldProviderModel : m));
          return { ...p, models };
        });
      });
    },
    onError: (err) => {
      toast.push("error", "Failed to update model", toastMessage(err));
    },
  });
}

export function useHeraldProjectSettings(projectId: string | undefined) {
  return useQuery({
    queryKey: ["herald-settings", projectId],
    queryFn: async () => {
      try {
        return await api.getHeraldProjectSettings(projectId!);
      } catch (err) {
        if ((err as { code?: string }).code === "PROVIDER_NOT_CONFIGURED") return null;
        throw err;
      }
    },
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

export function useSaveHeraldProjectSettings(projectId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (input: { providerId: string | null; modelId: string | null; fallbackModelIds: string[] }) =>
      api.putHeraldProjectSettings(projectId, input),
    onSuccess: (settings) => {
      qc.setQueryData(["herald-settings", projectId], settings);
      toast.push("success", "Herald provider saved");
    },
    onError: (err) => {
      toast.push("error", "Failed to save Herald provider", toastMessage(err));
    },
  });
}

export function useTestHeraldProjectSettings(projectId: string) {
  const toast = useToast();
  return useMutation({
    mutationFn: (input: { providerId: string | null; modelId: string | null }) =>
      api.testHeraldSettings(projectId, { kind: "openai_compatible", baseUrl: "", model: input.modelId ?? "" } as never),
    onError: (err) => {
      if (!toastMessage(err).includes("PROVIDER_")) toast.push("error", "Test failed", toastMessage(err));
    },
  });
}
