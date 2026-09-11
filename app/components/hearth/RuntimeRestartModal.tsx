import { useEffect, useState } from "react";
import { Check, Copy, RefreshCw, X } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "../../lib/api";
import { copyToClipboard } from "../../lib/clipboard";
import { useRuntimes } from "../../lib/queries";
import { parseApiDate } from "../../lib/date";
import { cn } from "../ui/cn";
import type { Machine, Runtime, RuntimeEvent } from "../../../shared/types";

const USER_TIME_ZONE = typeof window !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC";
const LAST_SEEN_FMT = new Intl.DateTimeFormat("en-GB", { timeZone: USER_TIME_ZONE });

function isOnline(lastSeen: string | null): boolean {
  return !!lastSeen && Date.now() - parseApiDate(lastSeen).getTime() < 2 * 60 * 1000;
}

function RestartNotice({ machineOnline, hostname }: { machineOnline: boolean; hostname: string | null }) {
  return (
    <div className={cn("card-row flex items-start gap-3 mb-4", machineOnline ? "card-row--warning" : "card-row--danger")}>
      <RefreshCw size={16} strokeWidth={1.5} className="text-lx-text-link flex-shrink-0" style={{ marginTop: 1 }} />
      <div>
        <div className="text-sm font-medium text-lx-text-primary">{machineOnline ? "Machine listener is online" : "Machine listener is offline"}</div>
        <div className="text-xs text-lx-text-secondary" style={{ marginTop: 2, lineHeight: 1.5 }}>
          {machineOnline ? "Send an update event. The listener restarts this runtime child and keeps its saved Settings configuration." : `Start the listener on ${hostname || "the runtime machine"}. The runtime remains in the list until it reconnects.`}
        </div>
      </div>
    </div>
  );
}

function OfflineCommand({ machine }: { machine: Machine | undefined }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void copyToClipboard("lexa-cli machine listen").then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="field">
      <div className="field-label">Listener command</div>
      <div style={{ background: "var(--lx-surface-input)", border: "1px solid var(--lx-border-default)", borderRadius: 6, padding: 12, position: "relative" }}>
        <pre className="font-mono text-xs text-lx-text-secondary whitespace-pre-wrap leading-6 m-0">lexa-cli machine listen</pre>
        <button type="button" className="btn btn-ghost" aria-label="Copy machine listen command" style={{ position: "absolute", top: 8, right: 8, height: 24, padding: "0 8px", fontSize: 11 }} onClick={copy}>{copied ? <Check size={12} strokeWidth={1.5} /> : <Copy size={12} strokeWidth={1.5} />} {copied ? "Copied" : "Copy"}</button>
      </div>
      <div className="field-hint mt-1.5">Last seen: {machine?.lastSeen ? LAST_SEEN_FMT.format(parseApiDate(machine.lastSeen)) : "never"}. This modal keeps polling.</div>
    </div>
  );
}

function SystemdCommand() {
  return (
    <div className="field">
      <div className="field-label">
        Or via systemd
        <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]" style={{ marginLeft: 6 }}>If installed</span>
      </div>
      <pre className="font-mono text-xs text-lx-text-secondary whitespace-pre-wrap leading-6 m-0" style={{ background: "var(--lx-surface-input)", border: "1px solid var(--lx-border-default)", borderRadius: 6, padding: 12 }}>{`systemctl --user restart lexa-hearth-listen
journalctl --user -u lexa-hearth-listen -f   # watch it reconnect`}</pre>
      <div className="field-hint mt-1.5">The listener re-reads per-runtime env files and respawns children. Settings config remains server-authoritative.</div>
    </div>
  );
}

function ProgressLine({ runtimeName, sendError, event, eventComplete, backOnline }: {
  runtimeName: string;
  sendError: string | null;
  event: RuntimeEvent | undefined;
  eventComplete: boolean;
  backOnline: boolean;
}) {
  if (sendError) return <div className="notice notice-warning mt-3">{sendError}</div>;
  if (event?.status === "failed") return <div className="notice notice-warning mt-3">{event.error || "The listener could not restart the runtime."}</div>;
  if (eventComplete && backOnline) {
    return <div className="card-row flex items-center gap-3 mt-4" style={{ background: "var(--lx-bg-success-subtle)" }}><span className="sync-dot sync-synced" /><span className="text-xs font-medium text-lx-text-primary">{runtimeName} is back online</span></div>;
  }
  return (
    <div className="card-row flex items-center gap-3 mt-4">
      <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
      <div className="flex-1">
        <div className="text-xs font-medium text-lx-text-primary">Waiting for the runtime child to come back…</div>
        <div className="text-xs text-lx-text-secondary" style={{ marginTop: 1 }}>Polls every 4s. This modal closes automatically once {runtimeName} is online again.</div>
      </div>
    </div>
  );
}

interface RestartFooterProps {
  machineOnline: boolean;
  eventId: string | null;
  event: RuntimeEvent | undefined;
  onClose: () => void;
  onRestart: () => void;
  onCheckAgain: () => void;
}

function RestartFooter({ machineOnline, eventId, event, onClose, onRestart, onCheckAgain }: RestartFooterProps) {
  return (
    <div className="flex justify-end mt-5" style={{ gap: 8 }}>
      <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
      {machineOnline && <button type="button" className="btn btn-primary" onClick={onRestart} disabled={!!eventId && event?.status !== "failed"}><RefreshCw size={12} strokeWidth={1.5} /> {eventId ? "Restart sent" : "Restart runtime"}</button>}
      {!machineOnline && <button type="button" className="btn btn-ghost" onClick={onCheckAgain}>Check again</button>}
    </div>
  );
}

export function RuntimeRestartModal({ runtime, onClose }: { runtime: Runtime; onClose: () => void }) {
  const [eventId, setEventId] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const qc = useQueryClient();
  const { data: runtimes = [] } = useRuntimes();
  const { data: machines = [] } = useQuery({
    queryKey: ["hearth-machines"],
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
            <RestartNotice machineOnline={machineOnline} hostname={runtime.hostname} />
            {!machineOnline && (
              <>
                <OfflineCommand machine={machine} />
                <SystemdCommand />
              </>
            )}
            <ProgressLine runtimeName={runtime.name} sendError={sendError} event={event} eventComplete={eventComplete} backOnline={backOnline} />
            <RestartFooter
              machineOnline={machineOnline}
              eventId={eventId}
              event={event}
              onClose={onClose}
              onRestart={restart}
              onCheckAgain={() => void qc.refetchQueries({ queryKey: ["hearth-machines"] })}
            />
          </div>
        </dialog>
      </div>
    </>
  );
}
