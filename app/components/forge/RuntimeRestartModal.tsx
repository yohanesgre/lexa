import { useEffect, useState } from "react";
import { Check, Copy, RefreshCw, X } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "../../lib/api";
import { copyToClipboard } from "../../lib/clipboard";
import { useRuntimes } from "../../lib/queries";
import { parseApiDate } from "../../lib/date";
import type { Runtime } from "../../../shared/types";

const USER_TIME_ZONE = typeof window !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC";
const LAST_SEEN_FMT = new Intl.DateTimeFormat("en-GB", { timeZone: USER_TIME_ZONE });

function isOnline(lastSeen: string | null): boolean {
  return !!lastSeen && Date.now() - parseApiDate(lastSeen).getTime() < 2 * 60 * 1000;
}

export function RuntimeRestartModal({ runtime, onClose }: { runtime: Runtime; onClose: () => void }) {
  const [eventId, setEventId] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const qc = useQueryClient();
  const { data: runtimes = [] } = useRuntimes();
  const { data: machines = [] } = useQuery({
    queryKey: ["forge-machines"],
    queryFn: () => api.listMachines().then((result) => result.data),
    refetchInterval: 4000,
  });
  const { data: event } = useQuery({
    queryKey: ["runtime-event", eventId],
    queryFn: () => api.getRuntimeEvent(eventId!),
    enabled: !!eventId,
    refetchInterval: eventId ? 4000 : false,
  });

  const machine = machines.find((candidate) => candidate.id === runtime.machineId);
  const machineOnline = !!machine && isOnline(machine.lastSeen);
  const current = runtimes.find((candidate) => candidate.id === runtime.id);
  const backOnline = current?.status === "online";
  const eventComplete = event?.status === "completed";

  useEffect(() => {
    if (eventComplete && backOnline) {
      const timer = window.setTimeout(onClose, 1200);
      return () => window.clearTimeout(timer);
    }
  }, [backOnline, eventComplete, onClose]);

  const restart = () => {
    if (!runtime.machineId) return;
    setSendError(null);
    api.createRuntimeEvent({ machineId: runtime.machineId, action: "update", agentCli: runtime.provider })
      .then((created) => setEventId(created.id))
      .catch((error: unknown) => setSendError(error instanceof Error ? error.message : "Could not send restart event"));
  };

  const copy = () => {
    void copyToClipboard("lexa-cli machine listen").then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <>
      <button type="button" className="slideover-overlay" onClick={onClose} aria-label="Close" />
      <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
        <dialog open className="dialog dialog-enter pointer-events-auto" aria-modal="true" aria-label="Restart runtime" style={{ maxWidth: 560, width: "100%" }}>
          <div className="modal-header">
            <span className="modal-title">Restart runtime — {runtime.name}</span>
            <button type="button" className="btn btn-ghost" style={{ width: 32, height: 32, padding: 0 }} onClick={onClose} aria-label="Close"><X size={16} strokeWidth={1.5} /></button>
          </div>
          <div className="modal-body">
            <div className="card-row flex items-start gap-3 mb-4" style={{ background: machineOnline ? "var(--lx-bg-warning-subtle)" : "var(--lx-bg-danger-subtle)" }}>
              <RefreshCw size={16} strokeWidth={1.5} className="text-lx-text-link flex-shrink-0" style={{ marginTop: 1 }} />
              <div>
                <div className="text-sm font-medium text-lx-text-primary">{machineOnline ? "Machine listener is online" : "Machine listener is offline"}</div>
                <div className="text-xs text-lx-text-secondary" style={{ marginTop: 2, lineHeight: 1.5 }}>
                  {machineOnline ? "Send an update event. The listener restarts this runtime child and keeps its saved Settings configuration." : `Start the listener on ${runtime.hostname || "the runtime machine"}. The runtime remains in the list until it reconnects.`}
                </div>
              </div>
            </div>

            {!machineOnline && (
              <div className="field">
                <div className="field-label">Run on the machine</div>
                <div style={{ background: "var(--lx-surface-input)", border: "1px solid var(--lx-border-default)", borderRadius: 6, padding: 12, position: "relative" }}>
                  <pre className="font-mono text-xs text-lx-text-secondary whitespace-pre-wrap leading-6 m-0">lexa-cli machine listen</pre>
                  <button type="button" className="btn btn-ghost" aria-label="Copy machine listen command" style={{ position: "absolute", top: 8, right: 8, height: 24, padding: "0 8px", fontSize: 11 }} onClick={copy}>{copied ? <Check size={12} strokeWidth={1.5} /> : <Copy size={12} strokeWidth={1.5} />} {copied ? "Copied" : "Copy"}</button>
                </div>
                <div className="field-hint mt-1.5">Last seen: {machine?.lastSeen ? LAST_SEEN_FMT.format(parseApiDate(machine.lastSeen)) : "never"}. This modal keeps polling.</div>
              </div>
            )}

            {sendError && <div className="notice notice-warning mt-3">{sendError}</div>}
            {event?.status === "failed" && <div className="notice notice-warning mt-3">{event.error || "The listener could not restart the runtime."}</div>}
            {eventComplete && backOnline ? (
              <div className="card-row flex items-center gap-3 mt-4" style={{ background: "var(--lx-bg-success-subtle)" }}><span className="sync-dot sync-synced" /><span className="text-xs font-medium text-lx-text-primary">{runtime.name} is back online</span></div>
            ) : eventId ? (
              <div className="flex items-center gap-3 mt-4" style={{ background: "var(--lx-surface-input)", border: "1px solid var(--lx-border-default)", borderRadius: 6, padding: "10px 12px" }}><span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /><span className="text-xs text-lx-text-secondary">Waiting for the listener to restart the child…</span></div>
            ) : null}

            <div className="flex justify-end mt-5" style={{ gap: 8 }}>
              <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
              {machineOnline && <button type="button" className="btn btn-primary" onClick={restart} disabled={!!eventId && event?.status !== "failed"}><RefreshCw size={12} strokeWidth={1.5} /> {eventId ? "Restart sent" : "Restart runtime"}</button>}
              {!machineOnline && <button type="button" className="btn btn-ghost" onClick={() => void qc.refetchQueries({ queryKey: ["forge-machines"] })}>Check again</button>}
            </div>
          </div>
        </dialog>
      </div>
    </>
  );
}
