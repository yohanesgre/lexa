import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, Monitor, RefreshCw, Terminal, X } from "lucide-react";
import * as api from "../../lib/api";
import { copyToClipboard } from "../../lib/clipboard";
import { Field } from "../ui/Field";
import { TextInput } from "../ui/TextInput";
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

function isMachineListening(machine: Machine): boolean {
  if (!machine.lastSeen) return false;
  return Date.now() - parseApiDate(machine.lastSeen).getTime() < 2 * 60 * 1000;
}

function formatLastSeen(machine: Machine): string {
  if (!machine.lastSeen) return "never seen";
  return parseApiDate(machine.lastSeen).toLocaleString();
}

function StepMachine({ machines, machinesLoading, machine, onSelect, onNext, onClose, createApiKey }: {
  machines: Machine[];
  machinesLoading: boolean;
  machine: Machine | null;
  onSelect: (m: Machine) => void;
  onNext: () => void;
  onClose: () => void;
  createApiKey: ReturnType<typeof useCreateApiKey>;
}) {
  const [machineKeyName, setMachineKeyName] = useState("");
  const [machineKeyRaw, setMachineKeyRaw] = useState<string | null>(null);
  const [machineKeyCopied, setMachineKeyCopied] = useState(false);

  const handleCreateMachineKey = () => {
    if (!machineKeyName.trim()) return;
    createApiKey.mutate(machineKeyName.trim(), {
      onSuccess: (result) => {
        setMachineKeyRaw(result.rawKey);
        setMachineKeyName("");
        void copyToClipboard(result.rawKey).then(() => setMachineKeyCopied(true));
      },
    });
  };

  const handleCopyMachineKey = async () => {
    if (!machineKeyRaw) return;
    await copyToClipboard(machineKeyRaw);
    setMachineKeyCopied(true);
  };

  return (
    <div>
      <h3 className="font-display text-base font-medium text-lx-text-primary mb-1">Choose a machine</h3>
      <p className="text-xs text-lx-text-secondary leading-5 mb-4">
        <span className="font-mono">lexa-cli login</span> binds the machine; <span className="font-mono">machine listen</span> brings it online. The new runtime will be bound to the machine you choose.
      </p>
      {machinesLoading ? (
        <div className="flex flex-col items-center gap-3 py-6">
          <span className="spinner" style={{ width: 20, height: 20, borderWidth: 2 }} />
          <div className="text-sm font-medium text-lx-text-primary">Looking for registered machines…</div>
        </div>
      ) : machines.length > 0 ? (
        <div className="flex flex-col gap-2">
          {machines.map((candidate) => {
            const listening = isMachineListening(candidate);
            return (
              <button
                key={candidate.id}
                type="button"
                disabled={!listening}
                onClick={() => onSelect(candidate)}
                className="card-row flex items-center gap-3 text-left w-full"
                style={{ opacity: listening ? 1 : 0.55, borderColor: machine?.id === candidate.id ? "var(--lx-border-focus)" : "var(--lx-border-default)", cursor: listening ? "pointer" : "not-allowed" }}
              >
                <Monitor size={16} strokeWidth={1.5} className={listening ? "text-lx-text-link" : "text-lx-text-muted"} />
                <span className="flex-1">
                  <span className="block text-sm font-medium text-lx-text-primary">{candidate.hostname || "Unnamed machine"}</span>
                  <span className="block text-xs text-lx-text-secondary">
                    {listening
                      ? `Listening · ${candidate.clis?.length ? candidate.clis.map((c) => `${c.provider} ${c.version}`).join(" · ") : "CLIs unknown"}`
                      : candidate.lastSeen
                        ? `Offline · last seen ${formatLastSeen(candidate)}`
                        : "Bound, not listening — run `lexa-cli machine listen`"}
                  </span>
                </span>
                <span className={cn("sync-dot", listening ? "sync-synced" : "sync-unlinked")} />
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
      {machineKeyRaw && (
        <div className="field-hint mt-1">Use the created key in <span className="font-mono">lexa-cli login --key</span> above.</div>
      )}

      <div className="mt-4">
        <h4 className="font-display text-sm font-medium text-lx-text-primary mb-1">Create an API key for this machine</h4>
        <p className="text-xs text-lx-text-secondary leading-5 mb-3">
          Used by <span className="font-mono">lexa-cli login</span> on the machine. The runtime gets its own key in the next step.
        </p>
        <Field label="Key name" htmlFor="machine-key-name" className="mb-4">
          <div className="flex gap-2">
            <TextInput id="machine-key-name" value={machineKeyName} onChange={setMachineKeyName} placeholder="e.g. lexa-machine" className="flex-1" onKeyDown={(event) => { if (event.key === "Enter") handleCreateMachineKey(); }} />
            <button type="button" className="btn btn-ghost" disabled={!machineKeyName.trim() || createApiKey.isPending} onClick={handleCreateMachineKey}>
              {createApiKey.isPending ? <RefreshCw size={14} strokeWidth={1.5} className="animate-spin" /> : <Check size={14} strokeWidth={1.5} />} Create
            </button>
          </div>
        </Field>
        {machineKeyRaw ? (
          <div style={{ background: "var(--lx-surface-input)", border: "1px solid var(--lx-border-default)", borderRadius: 6, padding: 8 }}>
            <div className="flex items-center gap-2">
              <code className="font-mono text-xs text-lx-text-secondary flex-1 truncate">{machineKeyRaw}</code>
              <button type="button" className="btn btn-ghost flex-shrink-0" style={{ height: 24, padding: "0 8px", fontSize: 11 }} onClick={handleCopyMachineKey}>
                {machineKeyCopied ? <Check size={12} strokeWidth={1.5} /> : <Copy size={12} strokeWidth={1.5} />} {machineKeyCopied ? "Copied" : "Copy"}
              </button>
            </div>
            <div className="field-hint mt-1">Raw key is held in memory and will not be shown again.</div>
          </div>
        ) : null}
      </div>
      <div className="flex justify-between mt-5">
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={!machine || !isMachineListening(machine)} onClick={onNext}>Continue</button>
      </div>
    </div>
  );
}

function StepAgent({ agentCli, onSelect, onBack, onNext }: {
  agentCli: ForgeProvider | null;
  onSelect: (id: ForgeProvider) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <div>
      <h3 className="font-display text-base font-medium text-lx-text-primary mb-1">Choose the agent CLI</h3>
      <p className="text-xs text-lx-text-secondary leading-5 mb-4">This selects the CLI the new runtime will manage. Provider/model, agent, and logging are configured after setup.</p>
      <div className="flex flex-col gap-2">
        {AGENTS.map((agent) => (
          <button key={agent.id} type="button" onClick={() => onSelect(agent.id)} className="card-row flex items-start gap-3 text-left w-full" style={{ borderColor: agentCli === agent.id ? "var(--lx-border-focus)" : "var(--lx-border-default)" }}>
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
        <button type="button" className="btn btn-ghost" onClick={onBack}>Back</button>
        <button type="button" className="btn btn-primary" disabled={!agentCli} onClick={onNext}>Continue</button>
      </div>
    </div>
  );
}

function StepKeySend({ machine, agentCli, newKeyName, createdRawKey, copied, canSend, sendError, onKeyNameChange, onCreateKey, onCopyKey, onBack, onSend, createApiKey }: {
  machine: Machine | null;
  agentCli: ForgeProvider | null;
  newKeyName: string;
  createdRawKey: string | null;
  copied: boolean;
  canSend: boolean;
  sendError: string | null;
  onKeyNameChange: (v: string) => void;
  onCreateKey: () => void;
  onCopyKey: () => void;
  onBack: () => void;
  onSend: () => void;
  createApiKey: ReturnType<typeof useCreateApiKey>;
}) {
  return (
    <div>
      <h3 className="font-display text-base font-medium text-lx-text-primary mb-1">Create key and install</h3>
      <p className="text-xs text-lx-text-secondary leading-5 mb-4">The fresh key is delivered once to the selected machine listener. Runtime settings become available after its first heartbeat.</p>
      <Field label="Key name" htmlFor="runtime-key-name" className="mb-4">
        <div className="flex gap-2">
          <TextInput id="runtime-key-name" value={newKeyName} onChange={onKeyNameChange} placeholder="e.g. forge-opencode" className="flex-1" onKeyDown={(event) => { if (event.key === "Enter") onCreateKey(); }} />
          <button type="button" className="btn btn-ghost" disabled={!newKeyName.trim() || createApiKey.isPending} onClick={onCreateKey}>
            {createApiKey.isPending ? <RefreshCw size={14} strokeWidth={1.5} className="animate-spin" /> : <Check size={14} strokeWidth={1.5} />} Create
          </button>
        </div>
      </Field>
      {createdRawKey ? (
        <div className="mb-4" style={{ background: "var(--lx-surface-input)", border: "1px solid var(--lx-border-default)", borderRadius: 6, padding: 8 }}>
          <div className="flex items-center gap-2">
            <code className="font-mono text-xs text-lx-text-secondary flex-1 truncate">{createdRawKey}</code>
            <button type="button" className="btn btn-ghost flex-shrink-0" style={{ height: 24, padding: "0 8px", fontSize: 11 }} onClick={onCopyKey}>
              {copied ? <Check size={12} strokeWidth={1.5} /> : <Copy size={12} strokeWidth={1.5} />} {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <div className="field-hint mt-1">Raw key is held in memory and will not be shown again.</div>
        </div>
      ) : <div className="notice notice-warning mb-4">Create a fresh key to continue.</div>}
      <div className="flex flex-col gap-2 mb-4">
        <div className="card-row flex items-center justify-between"><span className="text-sm text-lx-text-primary">Machine</span><span className="font-mono text-xs text-lx-text-secondary">{machine?.hostname || "—"}</span></div>
        <div className="card-row flex items-center justify-between"><span className="text-sm text-lx-text-primary">Agent CLI</span><span className="font-mono text-xs text-lx-text-secondary">{agentCli || "—"}</span></div>
      </div>
      {sendError && <div className="notice notice-warning mb-3">{sendError}</div>}
      <button type="button" className="btn btn-primary w-full" disabled={!canSend} onClick={onSend}>Send install event</button>
      <div className="flex justify-between mt-5">
        <button type="button" className="btn btn-ghost" onClick={onBack}>Back</button>
      </div>
    </div>
  );
}

function StepVerify({ eventFailed, eventDone, runtimeOnline, eventError, onClose }: {
  eventFailed: boolean;
  eventDone: boolean;
  runtimeOnline: boolean;
  eventError: string | null | undefined;
  onClose: () => void;
}) {
  return (
    <div>
      <div className="flex flex-col items-center gap-3 py-4">
        {eventFailed ? (
          <>
            <span className="sync-dot sync-unlinked" style={{ width: 12, height: 12 }} />
            <div className="text-sm font-medium text-lx-text-primary">Setup failed</div>
            <p className="text-xs text-lx-text-secondary text-center leading-5" style={{ maxWidth: 380 }}>{eventError || "The machine listener could not complete the install."}</p>
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
  );
}

export function RuntimeSetupModal({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [machine, setMachine] = useState<Machine | null>(null);
  const [agentCli, setAgentCli] = useState<ForgeProvider | null>(null);
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);
  const [createdRawKey, setCreatedRawKey] = useState<string | null>(null);
  const [newKeyName, setNewKeyName] = useState("");
  const [copied, setCopied] = useState(false);
  const [eventId, setEventId] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const createApiKey = useCreateApiKey();

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

  const handleCopyKey = async () => {
    if (!createdRawKey) return;
    await copyToClipboard(createdRawKey);
    setCopied(true);
  };

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

  const eventDone = event?.status === "completed";
  const eventFailed = event?.status === "failed";
  const runtimeOnline = !!machine && !!agentCli && runtimes.some((runtime) =>
    runtime.machineId === machine.id && runtime.provider === agentCli && runtime.status === "online"
  );
  const canSend = !!machine && !!agentCli && !!selectedKeyId && !!createdRawKey;

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
              <StepMachine
                machines={machines}
                machinesLoading={machinesLoading}
                machine={machine}
                onSelect={setMachine}
                onNext={() => setStep(1)}
                onClose={onClose}
                createApiKey={createApiKey}
              />
            )}

            {step === 1 && (
              <StepAgent
                agentCli={agentCli}
                onSelect={setAgentCli}
                onBack={() => setStep(0)}
                onNext={() => setStep(2)}
              />
            )}

            {step === 2 && (
              <StepKeySend
                machine={machine}
                agentCli={agentCli}
                newKeyName={newKeyName}
                createdRawKey={createdRawKey}
                copied={copied}
                canSend={canSend}
                sendError={sendError}
                onKeyNameChange={setNewKeyName}
                onCreateKey={handleCreateKey}
                onCopyKey={handleCopyKey}
                onBack={() => setStep(1)}
                onSend={sendInstall}
                createApiKey={createApiKey}
              />
            )}

            {step === 3 && (
              <StepVerify
                eventFailed={eventFailed}
                eventDone={eventDone}
                runtimeOnline={runtimeOnline}
                eventError={event?.error}
                onClose={onClose}
              />
            )}
          </div>
        </dialog>
      </div>
    </>
  );
}
