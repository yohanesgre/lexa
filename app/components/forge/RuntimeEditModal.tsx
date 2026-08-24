import { useMemo, useState } from "react";
import { Info, Trash2, X } from "lucide-react";
import { useUpdateRuntime } from "../../lib/queries";
import { Field } from "../ui/Field";
import { TextInput } from "../ui/TextInput";
import type { Runtime } from "../../../shared/types";

const PRESETS: Record<string, string[]> = {
  // opencode 1.18+ requires full provider/model ids — bare ids fail at spawn.
  opencode: ["opencode/deepseek-v4-flash", "opencode/deepseek-v4-pro", "opencode/deepseek-v4-flash-free"],
  "command-code": ["claude-sonnet-4-5", "claude-opus-4-5"],
  hermes: [],
};

const MAX_ARGS = 32;
const MAX_ARG_LEN = 200;

export function RuntimeEditModal({ runtime, onClose }: { runtime: Runtime; onClose: () => void }) {
  const [name, setName] = useState(runtime.name);
  const provider = runtime.provider;
  const [agent, setAgent] = useState(runtime.agent);
  const [agentCustom, setAgentCustom] = useState(() =>
    runtime.agentsCatalog.length > 0 && !runtime.agentsCatalog.some((entry) => entry.id === runtime.agent)
  );
  const [model, setModel] = useState(runtime.model);
  const [query, setQuery] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [custom, setCustom] = useState(() => {
    if (runtime.modelsCatalog.some((m) => m.id === runtime.model)) return false;
    return !PRESETS[runtime.provider]?.includes(runtime.model);
  });
  const [args, setArgs] = useState<string[]>(runtime.extraArgs);
  const [logLevel, setLogLevel] = useState(runtime.logLevel);
  const update = useUpdateRuntime();

  const presets = PRESETS[provider] ?? [];
  // The live catalog is reported by the daemon's CURRENT agent. If the
  // provider was switched in this modal, the catalog doesn't apply yet —
  // fall back to presets until the daemon heartbeats the new agent's models.
  const catalog = runtime.modelsCatalog;
  const agentCatalog = runtime.agentsCatalog;
  const trimmedArgs = args.map((a) => a.trim());
  const argsValid = trimmedArgs.every((a) => a.length > 0 && a.length <= MAX_ARG_LEN) && trimmedArgs.length <= MAX_ARGS;

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = catalog.filter(
      (m) => !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
    );
    const byProvider = new Map<string, typeof filtered>();
    for (const m of filtered) {
      const list = byProvider.get(m.provider) ?? [];
      list.push(m);
      byProvider.set(m.provider, list);
    }
    return [...byProvider.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [catalog, query]);

  const save = () => {
    update.mutate(
      { id: runtime.id, patch: { name: name.trim(), agent: agent.trim(), model: model.trim(), printLogs: true, logLevel, extraArgs: trimmedArgs } },
      { onSuccess: () => onClose() }
    );
  };

  const dirty = name.trim() !== runtime.name || agent.trim() !== runtime.agent || model.trim() !== runtime.model || logLevel !== runtime.logLevel || JSON.stringify(trimmedArgs) !== JSON.stringify(runtime.extraArgs);

  return (
    <>
      <button type="button" className="slideover-overlay" onClick={onClose} aria-label="Close" />
      <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
        <dialog open className="dialog dialog-enter pointer-events-auto" aria-modal="true" aria-label="Edit runtime" style={{ maxWidth: 560, width: "100%" }}>
          <div className="modal-header">
            <span className="modal-title">Edit runtime</span>
            <button type="button" className="btn btn-ghost" style={{ width: 32, height: 32, padding: 0 }} onClick={onClose} aria-label="Close">
              <X size={16} strokeWidth={1.5} />
            </button>
          </div>

          <div className="modal-body">
            {/* Identity (daemon-reported, read-only) */}
            <div className="card-row flex items-center gap-3 mb-5" style={{ background: "var(--lx-surface-input)" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="text-lx-text-muted flex-shrink-0"><rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" /></svg>
              <div className="flex-1">
                <div className="text-sm font-medium text-lx-text-primary">{runtime.name}</div>
                <div className="text-xs text-lx-text-secondary">
                  {runtime.provider} · {runtime.hostname || "—"} ·{" "}
                  <span className={runtime.status === "online" ? "text-lx-text-success" : "text-lx-text-muted"}>
                    {runtime.status === "online" ? "Online" : "Offline"}
                  </span>
                </div>
              </div>
              <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">Daemon-reported</span>
            </div>

            <Field label="Name" htmlFor="runtime-name" hint="Display name only. The daemon keeps its own FORGE_RUNTIME_NAME." className="field">
              <TextInput id="runtime-name" value={name} onChange={setName} />
            </Field>

            <div className="field">
              <div className="field-label">Agent CLI</div>
              <div className="prop-input w-full font-mono">{provider}</div>
              <div className="field-hint">Installed runtime identity. To use another CLI on this machine, create another runtime from Setup runtime.</div>
            </div>

            {(provider === "opencode" || agentCatalog.length > 0) && (
              <div className="field">
                <label className="field-label" htmlFor="runtime-agent">
                  Persona
                  <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]" style={{ marginLeft: 6 }}>CLI agent</span>
                </label>
                {agentCatalog.length > 0 ? (
                  <>
                    <select
                      id="runtime-agent"
                      className="prop-input w-full font-mono"
                      value={agentCustom ? "__custom__" : agent}
                      onChange={(e) => {
                        if (e.target.value === "__custom__") setAgentCustom(true);
                        else { setAgentCustom(false); setAgent(e.target.value); }
                      }}
                    >
                      <option value="">Default agent</option>
                      {agentCatalog.map((entry) => <option key={entry.id} value={entry.id}>{entry.id}{entry.name !== entry.id ? ` — ${entry.name}` : ""}</option>)}
                      <option value="__custom__">Custom…</option>
                    </select>
                    {agentCustom && <input className="prop-input w-full mt-2 font-mono" type="text" value={agent} onChange={(e) => setAgent(e.target.value)} placeholder="agent id" aria-label="Custom agent id" autoFocus />}
                  </>
                ) : (
                  <input className="prop-input w-full font-mono" type="text" value={agent} onChange={(e) => setAgent(e.target.value)} placeholder="build (default)" aria-label="Agent persona" />
                )}
                <div className="field-hint">The CLI listener reports available agents after setup. Empty = the CLI default. Applies on the next Hearth task.</div>
              </div>
            )}

            {provider === "opencode" && (
              <div className="field">
                <div className="field-label">
                  Logging
                  <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]" style={{ marginLeft: 6 }}>opencode run</span>
                </div>
                <div className="text-xs text-lx-text-secondary mb-2">
                  Diagnostic logs always print to stderr ({`--print-logs`}) and stream into the activity log.
                </div>
                <select
                  className="prop-input w-full"
                  aria-label="Log level"
                  value={logLevel}
                  onChange={(e) => setLogLevel(e.target.value as typeof logLevel)}
                >
                  <option value="">Default (opencode)</option>
                  {(["DEBUG", "INFO", "WARN", "ERROR"] as const).map((l) => (
                    <option key={l} value={l}>{l}</option>
                  ))}
                </select>
                <div className="field-hint">Controls the always-on opencode diagnostic stderr stream. The activity log captures stdout and stderr separately, with stored info/warn/error levels. Applies on the next Hearth task — no daemon restart needed.</div>
              </div>
            )}

            <div className="field">
              <div className="field-label" id="runtime-model-label">Model</div>
              {catalog.length > 0 ? (
                <>
                  <div className="relative">
                    <input
                      className="prop-input w-full font-mono"
                      type="text"
                      aria-labelledby="runtime-model-label"
                      value={pickerOpen ? query : model}
                      placeholder="Search models — provider/model…"
                      onChange={(e) => { setQuery(e.target.value); setPickerOpen(true); }}
                      onFocus={() => { setQuery(""); setPickerOpen(true); }}
                      onBlur={() => setTimeout(() => setPickerOpen(false), 150)}
                    />
                    {pickerOpen && (
                      <div
                        className="absolute z-50 flex flex-col"
                        style={{
                          top: "calc(100% + 4px)", left: 0, right: 0, maxHeight: 260, overflowY: "auto",
                          background: "var(--lx-surface-elevated)", border: "1px solid var(--lx-border-default)",
                          borderRadius: 6, padding: 8, boxShadow: "var(--lx-shadow-lg)", gap: 2,
                        }}
                      >
                        {groups.length === 0 && (
                          <div className="text-xs text-lx-text-muted" style={{ padding: "8px 6px" }}>No models match “{query}”.</div>
                        )}
                        {groups.map(([provider, models]) => (
                          <div key={provider}>
                            <div className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]" style={{ padding: "6px 8px" }}>{provider}</div>
                            {models.map((m) => (
                              <button
                                key={m.id}
                                type="button"
                                style={{
                                  display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
                                  width: "100%", padding: "6px 8px", borderRadius: 4, border: "none", cursor: "pointer",
                                  background: m.id === model ? "var(--lx-surface-selected)" : "transparent",
                                  color: "var(--lx-text-primary)", fontFamily: "var(--lx-font-mono)", fontSize: 12, textAlign: "left",
                                }}
                                onMouseDown={(e) => { e.preventDefault(); setModel(m.id); setCustom(false); setPickerOpen(false); }}
                              >
                                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.id}</span>
                                <span className="text-2xs text-lx-text-muted" style={{ fontFamily: "var(--lx-font-body)", flexShrink: 0 }}>{m.name}</span>
                              </button>
                            ))}
                          </div>
                        ))}
                        <div className="menu-separator" style={{ margin: "4px 0" }} />
                        <button
                          type="button"
                          style={{
                            display: "flex", alignItems: "center", width: "100%", padding: "6px 8px", borderRadius: 4,
                            border: "none", cursor: "pointer", background: "transparent", color: "var(--lx-text-link)", fontSize: 13, textAlign: "left",
                          }}
                          onMouseDown={(e) => { e.preventDefault(); setCustom(true); setPickerOpen(false); }}
                        >
                          Custom model…
                        </button>
                      </div>
                    )}
                  </div>
                  {custom && (
                    <input className="prop-input w-full mt-2 font-mono" type="text" value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. opencode/deepseek-v4-flash" aria-labelledby="runtime-model-label" autoFocus />
                  )}
                  <div className="field-hint">Live catalog reported by this runtime's agent, refreshed every ~10 min. Stores the full provider/model id — passed as --model.</div>
                </>
              ) : (
                <>
                  {presets.length > 0 ? (
                    <>
                      <select className="prop-input w-full" aria-labelledby="runtime-model-label" value={custom ? "__custom__" : model} onChange={(e) => {
                        if (e.target.value === "__custom__") setCustom(true);
                        else { setCustom(false); setModel(e.target.value); }
                      }}>
                        {!custom && !presets.includes(model) ? <option value={model}>{model}</option> : null}
                        {presets.map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                        <option value="__custom__">Custom…</option>
                      </select>
                      {custom && (
                        <input className="prop-input w-full mt-2 font-mono" type="text" value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. deepseek-v4-flash" aria-labelledby="runtime-model-label" autoFocus />
                      )}
                    </>
                  ) : (
                    <input className="prop-input w-full font-mono" type="text" aria-labelledby="runtime-model-label" value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. deepseek-v4-flash" />
                  )}
                  <div className="field-hint">Runtime offline or its agent has no scriptable model list (hermes) — falling back to presets. Reconnect the daemon to refresh the live catalog.</div>
                </>
              )}
            </div>

            <div className="field">
              <div className="field-label">
                Extra args
                <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]" style={{ marginLeft: 6 }}>Optional</span>
              </div>
              <div className="flex flex-col" style={{ gap: 6 }}>
                {args.map((arg, i) => (
                  <div key={arg} className="flex items-center gap-2">
                    <span className="font-mono text-2xs text-lx-text-muted" style={{ width: 14 }}>{i + 1}</span>
                    <input
                      className="prop-input flex-1 font-mono"
                      type="text"
                      aria-label={`Extra arg ${i + 1}`}
                      value={arg}
                      onChange={(e) => {
                        const next = [...args];
                        next[i] = e.target.value;
                        setArgs(next);
                      }}
                    />
                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={{ width: 28, height: 28, padding: 0 }}
                      aria-label={`Remove arg ${i + 1}`}
                      onClick={() => setArgs(args.filter((_, j) => j !== i))}
                    >
                      <Trash2 size={14} strokeWidth={1.5} />
                    </button>
                  </div>
                ))}
                {args.length < MAX_ARGS && (
                  <button type="button" className="btn btn-ghost" style={{ alignSelf: "flex-start", height: 28, padding: "0 10px", fontSize: 12 }} onClick={() => setArgs([...args, ""])}>
                    <span style={{ fontSize: 14, lineHeight: 1 }}>+</span>
                    Add arg
                  </button>
                )}
              </div>
              <div className="field-hint">Appended to the agent CLI for every task on this runtime — e.g. --temperature 0.2. Tokens are passed verbatim (no shell). Up to 32 args.</div>
            </div>

            <div className="notice mt-2 flex items-center gap-2">
              <Info size={16} strokeWidth={1.5} className="text-lx-text-link flex-shrink-0" />
              <span className="text-xs text-lx-text-secondary">Applies to the next Hearth task on this runtime. No daemon restart needed.</span>
            </div>

            <div className="flex justify-end mt-5" style={{ gap: 8 }}>
              <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={!dirty || !name.trim() || !model.trim() || !argsValid || update.isPending} onClick={save}>
                {update.isPending ? "Saving…" : "Save changes"}
              </button>
            </div>
          </div>
        </dialog>
      </div>
    </>
  );
}
