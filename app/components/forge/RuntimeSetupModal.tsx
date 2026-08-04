import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, Monitor, RefreshCw, Terminal, X } from "lucide-react";
import * as api from "../../lib/api";
import { copyToClipboard } from "../../lib/clipboard";
import { cn } from "../ui/cn";
import { useCreateApiKey } from "../../lib/queries";
import { parseApiDate } from "../../lib/date";
import type { ForgeProvider, Machine } from "../../../shared/types";

const STEPS = ["Machine", "Agent CLI", "Key / Send", "Verify"] as const;

const AGENTS: Array<{ id: ForgeProvider; name: string; desc: string; runs: string }> = [
  { id: "opencode", name: "opencode", desc: "General coding agent. Configure its agent and model after setup.", runs: "opencode run <prompt>" },
  { id: "hermes", name: "hermes", desc: "Self-hosted assistant. The listener reports available choices after setup.", runs: "hermes -p <prompt>" },
  { id: "command-code", name: "command-code", desc: "Claude Code CLI in non-interactive mode.", runs: "cmd -p <prompt>" },
];

function isMachineOnline(machine: Machine): boolean {
  if (!machine.lastSeen) return false;
  return Date.now() - parseApiDate(machine.lastSeen).getTime() < 2 * 60 * 1000;
}

function formatLastSeen(machine: Machine): string {
  if (!machine.lastSeen) return "never seen";
  return parseApiDate(machine.lastSeen).toLocaleString();
}

export function RuntimeSetupModal({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [machine, setMachine] = useState<Machine | null>(null);
  const [agentCli, setAgentCli] = useState<ForgeProvider | null>(null);
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);
  const [newKeyName, setNewKeyName] = useState("");
  const [createdRawKey, setCreatedRawKey] = useState<string | null>(null);
  const [eventId, setEventId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const createApiKey = useCreateApiKey();

  const { data: machines = [], isLoading: machinesLoading } = useQuery({
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
  const { data: runtimes = [] } = useQuery({
    queryKey: ["forge-runtimes"],
    queryFn: () => api.listRuntimes().then((result) => result.data),
    refetchInterval: eventId ? 4000 : false,
  });

  const onlineMachines = machines.filter(isMachineOnline);
  const eventDone = event?.status === "completed";
  const eventFailed = event?.status === "failed";
  const runtimeOnline = !!machine && !!agentCli && runtimes.some((runtime) =>
    runtime.machineId === machine.id && runtime.provider === agentCli && runtime.status === "online"
  );
  const canSend = !!machine && !!agentCli && !!selectedKeyId && !!createdRawKey;


  const handleCopyKey = async () => {
    if (!createdRawKey) return;
    await copyToClipboard(createdRawKey);
    setCopied(true);
  };


  const handleCreateKey = () => {
    if (!newKeyName.trim()) return;
    createApiKey.mutate(newKeyName.trim(), {
      onSuccess: (result) => {
        setCreatedRawKey(result.rawKey);
        setSelectedKeyId(result.key.id);
        setNewKeyName("");
        void copyToClipboard(result.rawKey).then(() => setCopied(true));
      },
    });
  };

  const sendInstall = () => {
    if (!machine || !agentCli || !selectedKeyId || !createdRawKey) return;
    setSendError(null);
    api.createRuntimeEvent({
      machineId: machine.id,
      action: "install",
      agentCli,
      apiKeyId: selectedKeyId,
      rawKey: createdRawKey,
    }).then((created) => {
      setEventId(created.id);
      setStep(3);
    }).catch((error: unknown) => {
      setSendError(error instanceof Error ? error.message : "Could not send install event");
    });
  };

  return (
    <>
      <button type="button" className="slideover-overlay" onClick={onClose} aria-label="Close" />
      <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
        <dialog open className="dialog dialog-enter pointer-events-auto" aria-modal="true" aria-label="Setup runtime" style={{ maxWidth: 560, width: "100%" }}>
          <div className="modal-header">
            <span className="modal-title">Setup runtime</span>
            <button type="button" className="btn btn-ghost" style={{ width: 32, height: 32, padding: 0 }} onClick={onClose} aria-label="Close">
              <X size={16} strokeWidth={1.5} />
            </button>
          </div>

          <div className="modal-body">
            <div className="flex items-center justify-center gap-1.5 mb-5">
              {STEPS.map((label, index) => (
                <div key={label} className="flex items-center gap-1.5">
                  {index > 0 && <div className="w-6 h-px bg-lx-border-default" />}
                  <div className={cn("flex items-center gap-1", index === step ? "text-lx-text-primary" : index < step ? "text-lx-text-success" : "text-lx-text-muted")}>
                    <span className={cn("w-5 h-5 rounded-full border flex items-center justify-center text-[10px] font-medium", index === step ? "border-lx-border-focus text-lx-text-link" : index < step ? "border-lx-text-success" : "border-lx-border-default")}>
                      {index < step ? <Check size={10} strokeWidth={3} /> : index + 1}
                    </span>
                    <span className="text-xs font-body">{label}</span>
                  </div>
                </div>
              ))}
            </div>

            {step === 0 && (
              <div>
                <h3 className="font-display text-base font-medium text-lx-text-primary mb-1">Choose a machine</h3>
                <p className="text-xs text-lx-text-secondary leading-5 mb-4">
                  The machine listener registers itself after <span className="font-mono">lexa-cli login</span> and keeps this list current.
                </p>
                {machinesLoading ? (
                  <div className="flex flex-col items-center gap-3 py-6">
                    <span className="spinner" style={{ width: 20, height: 20, borderWidth: 2 }} />
                    <div className="text-sm font-medium text-lx-text-primary">Looking for registered machines…</div>
                  </div>
                ) : machines.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    {machines.map((candidate) => {
                      const online = isMachineOnline(candidate);
                      return (
                        <button
                          key={candidate.id}
                          type="button"
                          disabled={!online}
                          onClick={() => setMachine(candidate)}
                          className="flex items-center gap-3 text-left w-full"
                          style={{ opacity: online ? 1 : 0.55, background: "var(--lx-surface-card)", border: `1px solid ${machine?.id === candidate.id ? "var(--lx-border-focus)" : "var(--lx-border-default)"}`, borderRadius: 6, padding: "10px 12px", cursor: online ? "pointer" : "not-allowed" }}
                        >
                          <Monitor size={16} strokeWidth={1.5} className={online ? "text-lx-text-link" : "text-lx-text-muted"} />
                          <span className="flex-1">
                            <span className="block text-sm font-medium text-lx-text-primary">{candidate.hostname || "Unnamed machine"}</span>
                            <span className="block text-xs text-lx-text-secondary">{online ? "Online now" : `Offline · last seen ${formatLastSeen(candidate)}`}</span>
                          </span>
                          <span className={cn("sync-dot", online ? "sync-synced" : "sync-unlinked")} />
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="notice notice-warning">
                    <span>No machines registered. On the target machine run <span className="font-mono">lexa-cli login</span>, then <span className="font-mono">lexa-cli machine listen</span>.</span>
                  </div>
                )}
                <pre className="font-mono text-xs text-lx-text-secondary whitespace-pre-wrap leading-6 mt-3" style={{ background: "var(--lx-surface-input)", border: "1px solid var(--lx-border-default)", borderRadius: 6, padding: 12 }}>
{`lexa-cli login --url <lexa-url> --key <lxk_...>
lexa-cli machine listen`}
                </pre>
                <div className="flex justify-between mt-5">
                  <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
                  <button type="button" className="btn btn-primary" disabled={!machine || !isMachineOnline(machine)} onClick={() => setStep(1)}>Continue</button>
                </div>
              </div>
            )}

            {step === 1 && (
              <div>
                <h3 className="font-display text-base font-medium text-lx-text-primary mb-1">Choose the agent CLI</h3>
                <p className="text-xs text-lx-text-secondary leading-5 mb-4">This selects the CLI the new runtime will manage. Provider/model, agent, and logging are configured after setup.</p>
                <div className="flex flex-col gap-2">
                  {AGENTS.map((agent) => (
                    <button key={agent.id} type="button" onClick={() => setAgentCli(agent.id)} className="flex items-start gap-3 text-left w-full" style={{ background: "var(--lx-surface-card)", border: `1px solid ${agentCli === agent.id ? "var(--lx-border-focus)" : "var(--lx-border-default)"}`, borderRadius: 6, padding: "10px 12px" }}>
                      <Terminal size={16} strokeWidth={1.5} className={cn("flex-shrink-0 mt-0.5", agentCli === agent.id ? "text-lx-text-link" : "text-lx-text-muted")} />
                      <span className="flex-1">
                        <span className="block text-sm font-medium text-lx-text-primary">{agent.name}</span>
                        <span className="block text-xs text-lx-text-secondary leading-5">{agent.desc}</span>
                        <span className="block font-mono text-2xs text-lx-text-muted mt-0.5">{agent.runs}</span>
                      </span>
                      <span className={cn("checkbox flex-shrink-0", agentCli === agent.id && "checked")} />
                    </button>
                  ))}
                </div>
                <div className="flex justify-between mt-5">
                  <button type="button" className="btn btn-ghost" onClick={() => setStep(0)}>Back</button>
                  <button type="button" className="btn btn-primary" disabled={!agentCli} onClick={() => setStep(2)}>Continue</button>
                </div>
              </div>
            )}

            {step === 2 && (
              <div>
                <h3 className="font-display text-base font-medium text-lx-text-primary mb-1">Create key and install</h3>
                <p className="text-xs text-lx-text-secondary leading-5 mb-4">The fresh key is delivered once to the selected machine listener. Runtime settings become available after its first heartbeat.</p>
                <div className="field mb-4">
                  <label className="prop-label block mb-1" htmlFor="runtime-key-name">Key name</label>
                  <div className="flex gap-2">
                    <input id="runtime-key-name" className="prop-input flex-1" type="text" value={newKeyName} onChange={(event) => setNewKeyName(event.target.value)} placeholder="e.g. forge-opencode" onKeyDown={(event) => { if (event.key === "Enter") handleCreateKey(); }} />
                    <button type="button" className="btn btn-ghost" disabled={!newKeyName.trim() || createApiKey.isPending} onClick={handleCreateKey}>
                      {createApiKey.isPending ? <RefreshCw size={14} strokeWidth={1.5} className="animate-spin" /> : <Check size={14} strokeWidth={1.5} />} Create
                    </button>
                  </div>
                </div>
                {createdRawKey ? (
                  <div className="mb-4" style={{ background: "var(--lx-surface-input)", border: "1px solid var(--lx-border-default)", borderRadius: 6, padding: 8 }}>
                    <div className="flex items-center gap-2">
                      <code className="font-mono text-xs text-lx-text-secondary flex-1 truncate">{createdRawKey}</code>
                      <button type="button" className="btn btn-ghost flex-shrink-0" style={{ height: 24, padding: "0 8px", fontSize: 11 }} onClick={handleCopyKey}>
                        {copied ? <Check size={12} strokeWidth={1.5} /> : <Copy size={12} strokeWidth={1.5} />} {copied ? "Copied" : "Copy"}
                      </button>
                    </div>
                    <div className="field-hint mt-1">Raw key is held in memory and will not be shown again.</div>
                  </div>
                ) : <div className="notice notice-warning mb-4">Create a fresh key to continue.</div>}
                <div className="flex flex-col gap-2 mb-4">
                  <div className="flex items-center justify-between" style={{ background: "var(--lx-surface-card)", border: "1px solid var(--lx-border-default)", borderRadius: 6, padding: "10px 12px" }}><span className="text-sm text-lx-text-primary">Machine</span><span className="font-mono text-xs text-lx-text-secondary">{machine?.hostname || "—"}</span></div>
                  <div className="flex items-center justify-between" style={{ background: "var(--lx-surface-card)", border: "1px solid var(--lx-border-default)", borderRadius: 6, padding: "10px 12px" }}><span className="text-sm text-lx-text-primary">Agent CLI</span><span className="font-mono text-xs text-lx-text-secondary">{agentCli || "—"}</span></div>
                </div>
                {sendError && <div className="notice notice-warning mb-3">{sendError}</div>}
                <button type="button" className="btn btn-primary w-full" disabled={!canSend} onClick={sendInstall}>Send install event</button>
                <div className="flex justify-between mt-5">
                  <button type="button" className="btn btn-ghost" onClick={() => setStep(1)}>Back</button>
                </div>
              </div>
            )}

            {step === 3 && (
              <div>
                <div className="flex flex-col items-center gap-3 py-4">
                  {eventFailed ? (
                    <>
                      <span className="sync-dot sync-unlinked" style={{ width: 12, height: 12 }} />
                      <div className="text-sm font-medium text-lx-text-primary">Setup failed</div>
                      <p className="text-xs text-lx-text-secondary text-center leading-5" style={{ maxWidth: 380 }}>{event?.error || "The machine listener could not complete the install."}</p>
                    </>
                  ) : eventDone && runtimeOnline ? (
                    <>
                      <span className="sync-dot sync-synced" style={{ width: 12, height: 12 }} />
                      <div className="text-sm font-medium text-lx-text-primary">Runtime is online</div>
                      <p className="text-xs text-lx-text-secondary text-center leading-5" style={{ maxWidth: 380 }}>
                        Configure its agent, provider/model, and logging from the runtime settings row.
                      </p>
                    </>
                  ) : (
                    <>
                      <span className="spinner" style={{ width: 20, height: 20, borderWidth: 2 }} />
                      <div className="text-sm font-medium text-lx-text-primary">Waiting for the machine listener…</div>
                      <p className="text-xs text-lx-text-secondary text-center leading-5" style={{ maxWidth: 380 }}>The event and runtime heartbeat refresh automatically.</p>
                    </>
                  )}
                </div>
                <div className="flex justify-end mt-5">
                  <button type="button" className={eventDone && runtimeOnline ? "btn btn-primary" : "btn btn-ghost"} onClick={onClose}>{eventDone && runtimeOnline ? "Done" : "Close"}</button>
                </div>
              </div>
            )}
          </div>
        </dialog>
      </div>
    </>
  );
}
