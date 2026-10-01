import { useCapabilities } from "./queries";

// Capability gate (ADR-0003 §F.3): `GET /api/capabilities` is the single
// honest signal for whether the assistant surface exists on this deployment.
// `assistant:true` only on the Cloudflare Workers flavor with the secrets
// master key; Docker/Bun reports false. While the read is in flight the surface
// stays hidden/gated rather than optimistically rendering dead controls, so
// `enabled` is strictly true only once the flag has resolved true.
export interface AssistantEnabled {
  enabled: boolean;
  loading: boolean;
  flavor: "bun" | "workers" | undefined;
}

export function useAssistantEnabled(opts?: { enabled?: boolean }): AssistantEnabled {
  const { data, isLoading } = useCapabilities({ enabled: opts?.enabled ?? true });
  return {
    enabled: data?.assistant === true,
    loading: isLoading,
    flavor: data?.flavor,
  };
}
