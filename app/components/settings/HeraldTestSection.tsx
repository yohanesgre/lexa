import { useRef, useState } from "react";
import { useToast } from "../ui/Toast";
import { hasPrimary, testConnection } from "./herald-project-logic";
import { HeraldTestPanel } from "./HeraldTestPanel";
import type { HeraldProviderModel } from "../../../shared/herald";

type FallbackRow = HeraldProviderModel & { providerLabel: string; providerId: string };

// Test connection control: fires the minimal completion ping (+ fallback
// chain display while pending), reports outcome via toast.
export function HeraldTestSection({
  projectId,
  providerId,
  modelId,
  fallbacks,
  fallbackRows,
  providerLabel,
}: {
  projectId: string;
  providerId: string;
  modelId: string;
  fallbacks: string[];
  fallbackRows: FallbackRow[];
  providerLabel: string;
}) {
  const toast = useToast();
  const testInFlightRef = useRef(false);
  const [testState, setTestState] = useState<"idle" | "pending" | "ok" | "fail">("idle");

  const handleTest = async () => {
    if (testInFlightRef.current || testState === "pending") return;
    testInFlightRef.current = true;
    setTestState("pending");
    const result = await testConnection(projectId, { providerId: providerId || null, modelId: modelId || null, fallbackModelIds: fallbacks });
    testInFlightRef.current = false;
    setTestState("idle");
    if (result.ok) toast.push("success", `Connection OK · ${result.latencyMs} ms`, "Provider reachable · key valid");
    else toast.push("error", result.code, result.msg);
  };

  return (
    <>
      <button type="button" className="btn btn-ghost" style={{ height: 28, padding: "0 10px", fontSize: 12 }} onClick={handleTest} disabled={!hasPrimary(providerId, modelId) || testState === "pending"}>
        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" /></svg>
        Test connection
      </button>
      {testState === "pending" && (
        <HeraldTestPanel
          total={1 + fallbacks.length}
          primaryLabel={modelId || "—"}
          providerLabel={providerLabel}
          fallbackRows={fallbackRows}
        />
      )}
    </>
  );
}
