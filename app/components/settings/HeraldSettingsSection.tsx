import { useEffect, useRef, useState } from "react";
import { Check, EyeOff, Plus, RefreshCw, Trash2, X, Zap } from "lucide-react";
import { cn } from "../ui/cn";
import type { ProviderKind, HearthEngine, HeraldReasoningEffort } from "../../../shared/herald";
import {
  useHeraldSettings,
  useSaveHeraldSettings,
  useTestHeraldSettings,
  useFetchHeraldModels,
  useHeraldMemory,
  useAddHeraldMemory,
  useRemoveHeraldMemory,
  useAgents,
  useSkills,
  useReplaceAgentSkills,
} from "../../lib/queries";
import { ENGINE_AGENT_IDS } from "../../lib/use-hearth-engine";
import type { HeraldSettingsMasked, HeraldSettingsInput } from "../../../shared/herald";
import type { HeraldMemoryEntry } from "../../lib/api";
import { formatRelative } from "../../lib/relative-time";
import type { Project } from "../../../shared/types";

// Per-project Herald provider (incl. vision fields) + engine + skill
// availability + memory curation — transcribed from
// wireframes/src/settings-project-herald.html. Keys are write-only: the GET
// returns a masked view and PUT omits untouched key fields (stored values
// kept server-side).

// PUT requires kind/baseUrl/model — partial saves (engine, vision) ride on
// the stored masked values so only the touched fields actually change.
function storedBaseInput(settings: HeraldSettingsMasked): HeraldSettingsInput {
  return { kind: settings.kind, baseUrl: settings.baseUrl, model: settings.model };
}

export function HeraldProviderSection({ project }: { project: Project }) {
  const { data: settings, isLoading } = useHeraldSettings(project.id);
  const save = useSaveHeraldSettings(project.id);
  const test = useTestHeraldSettings(project.id);
  const fetchModels = useFetchHeraldModels(project.id);

  const [kind, setKind] = useState<ProviderKind>("openai_compatible");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<HeraldReasoningEffort | "">("");
  const [supportsImages, setSupportsImages] = useState(false);
  const [visionModel, setVisionModel] = useState("");
  const [searchProvider, setSearchProvider] = useState<"exa" | "none">("exa");
  const [replacingSearchKey, setReplacingSearchKey] = useState(false);
  const [searchApiKey, setSearchApiKey] = useState("");
  const [urlAllowlist, setUrlAllowlist] = useState("");
  const [modelsOpen, setModelsOpen] = useState(false);
  const [modelFilter, setModelFilter] = useState("");
  const [visionModelsOpen, setVisionModelsOpen] = useState(false);
  const [visionModelFilter, setVisionModelFilter] = useState("");
  const [hydratedProjectId, setHydratedProjectId] = useState<string | null>(null);

  // Hydrate the form once per project from the masked view.
  useEffect(() => {
    if (settings && hydratedProjectId !== project.id) {
      setKind(settings.kind);
      setBaseUrl(settings.baseUrl);
      setModel(settings.model);
      setReasoningEffort(settings.reasoningEffort ?? "");
      setSupportsImages(settings.primarySupportsImages);
      setVisionModel(settings.visionModel ?? "");
      setSearchProvider(settings.searchProvider === "exa" ? "exa" : "none");
      setUrlAllowlist(settings.urlAllowlist ?? "");
      setHydratedProjectId(project.id);
      setReplacingSearchKey(false);
      setApiKey("");
      setSearchApiKey("");
    }
  }, [settings, project.id, hydratedProjectId]);

  const formInput = () => ({
    kind,
    baseUrl: baseUrl.trim(),
    model: model.trim(),
    ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    reasoningEffort: (reasoningEffort || null) as HeraldReasoningEffort | null,
    primarySupportsImages: supportsImages,
    visionModel: visionModel.trim() || null,
    searchProvider: searchProvider === "exa" ? ("exa" as const) : null,
    ...(searchApiKey.trim() ? { searchApiKey: searchApiKey.trim() } : replacingSearchKey && searchProvider === "exa" ? { searchApiKey: null } : {}),
    urlAllowlist: urlAllowlist.trim() || null,
  });

  const handleSave = () =>
    save.mutate(formInput(), {
      // Saved-key badge refreshes from the mutation response (setQueryData in
      // useSaveHeraldSettings); the field returns to its "keep stored" state.
      onSuccess: () => setApiKey(""),
    });

  const handleTest = () =>
    test.mutate(formInput(), {
      onSuccess: () => setModelsOpen(false),
    });

  const handleFetchModels = () =>
    fetchModels.mutate(formInput(), {
      onSuccess: () => { setModelsOpen(true); setModelFilter(""); },
    });

  const testState: "idle" | "pending" | "ok" | "fail" = test.isPending
    ? "pending"
    : test.isSuccess
      ? "ok"
      : test.isError
        ? "fail"
        : "idle";

  if (isLoading) {
    return (
      <section className="mb-8 mt-4">
        <h2 className="font-display text-lg font-medium text-lx-text-primary mb-3">Herald provider</h2>
        <div className="card-panel card-panel--elevated skeleton" style={{ height: 120 }} />
      </section>
    );
  }

  return (
    <section className="mb-8 mt-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-display text-lg font-medium text-lx-text-primary">Herald provider</h2>
        <span className="text-xs text-lx-text-muted">Per project</span>
      </div>
      <p className="text-sm text-lx-text-secondary mb-4" style={{ maxWidth: 640 }}>
        Herald (the writing assistant in the Hearth popover) runs against an OpenAI-compatible or Anthropic-compatible endpoint. Keys live server-side only and are never serialized back to the browser.
      </p>

      <div className="card-panel card-panel--elevated">
        {/* Kind */}
        <div className="field">
          <label className="field-label">Kind</label>
          <select
            className="prop-input w-full"
            aria-label="Provider kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as ProviderKind)}
            style={{ maxWidth: 320 }}
          >
            <option value="openai_compatible">OpenAI-compatible</option>
            <option value="anthropic_compatible">Anthropic-compatible</option>
          </select>
          <div className="field-hint">Both kinds are custom baseURL-capable. Base URL is normalized per kind (/v1 appended when absent) before any request.</div>
        </div>

        {/* Base URL */}
        <div className="field">
          <label className="field-label" htmlFor="herald-base-url">Base URL</label>
          <input id="herald-base-url" className="prop-input w-full font-mono" type="text" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://openrouter.ai/api/v1" style={{ maxWidth: 480 }} />
          <div className="field-hint">OpenRouter shown as an example — any compatible endpoint works.</div>
        </div>

        {/* API key — one always-editable password input + server-truth badge.
            No read-only mask box, no Replace… mode switch: the old fake input
            looked editable but typing into it never reached Save, so the
            stored key silently survived. The badge is server truth rendered
            OUTSIDE the input; the save mutation refreshes it from the
            response. Eye/reveal dropped deliberately: stored keys are never
            serialized back, so reveal is impossible by design; the in-progress
            value stays masked (paste, don't type). */}
        <div className="field">
          <div className="flex items-center gap-2" style={{ marginBottom: 6 }}>
            <label className="field-label" htmlFor="herald-api-key" style={{ marginBottom: 0 }}>API key</label>
            {settings?.hasKey && (
              <span
                className="chip font-micro text-2xs"
                style={{ display: "inline-flex", alignItems: "center", gap: 5, height: 20, padding: "0 8px", background: "var(--lx-bg-accent-subtle)", color: "var(--lx-text-link)" }}
                title="Stored server-side — never serialized to the browser"
              >
                <EyeOff size={10} strokeWidth={1.5} />
                Saved · <span className="font-mono">{settings.keyMask ?? "sk-…"}</span>
              </span>
            )}
          </div>
          <input
            id="herald-api-key"
            className="prop-input w-full font-mono"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={settings?.hasKey ? `Type to replace ${settings.keyMask ?? "sk-…"}` : "sk-…"}
            aria-label="API key"
            autoComplete="off"
            style={{ maxWidth: 480 }}
          />
          <div className="field-hint">
            {settings?.hasKey
              ? <>Empty keeps the stored key (<span className="font-mono">{settings.keyMask ?? "sk-…"}</span>). Typing a new key replaces it on Save.</>
              : "Paste a key — it is stored server-side and never shown again."}
          </div>
        </div>

        {/* Model combobox with Fetch models dropdown */}
        <div className="field">
          <label className="field-label" htmlFor="herald-model">Model</label>
          <div style={{ position: "relative", maxWidth: 480 }}>
            <div className="flex items-center gap-2">
              <input id="herald-model" className="prop-input flex-1 font-mono" type="text" value={model} onChange={(e) => setModel(e.target.value)} placeholder="model id…" />
              <button type="button" className="btn btn-ghost btn-sm" style={{ flexShrink: 0 }} onClick={handleFetchModels} disabled={fetchModels.isPending || !baseUrl.trim()}>
                <RefreshCw size={12} strokeWidth={1.5} className={fetchModels.isPending ? "animate-spin" : undefined} />
                Fetch models
              </button>
            </div>
            {modelsOpen && (() => {
              const allModels = fetchModels.data?.models ?? [];
              const visible = allModels.filter((m) => m.id.toLowerCase().includes(modelFilter.toLowerCase()));
              return (
              <div className="menu" style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 30, padding: 8, display: "flex", flexDirection: "column", gap: 2 }}>
                <div className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]" style={{ padding: "4px 8px" }}>Fetched from provider · GET {"{base}"}/models</div>
                <input
                  className="prop-input w-full font-mono"
                  type="text"
                  value={modelFilter}
                  onChange={(e) => setModelFilter(e.target.value)}
                  placeholder="Search models…"
                  aria-label="Search models"
                  style={{ height: 28, fontSize: 12, marginBottom: 4 }}
                />
                <div style={{ maxHeight: 264, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
                {visible.length === 0 ? (
                  <div className="text-xs text-lx-text-muted" style={{ padding: "8px 8px" }}>No models match &quot;{modelFilter}&quot;</div>
                ) : visible.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className="menu-item font-mono"
                    style={{
                      height: 28,
                      fontSize: 12,
                      justifyContent: "space-between",
                      ...(model === m.id ? { background: "var(--lx-surface-selected)", color: "var(--lx-text-primary)" } : {}),
                    }}
                    onClick={() => { setModel(m.id); setModelsOpen(false); }}
                  >
                    <span>{m.id}</span>
                    {model === m.id && <Check size={12} strokeWidth={2.5} />}
                  </button>
                ))}
                </div>
                <div className="font-micro text-2xs text-lx-text-muted" style={{ padding: "4px 8px" }}>{visible.length} of {allModels.length} models</div>
                <div className="menu-separator" style={{ margin: "4px 0" }} />
                <button
                  type="button"
                  className="menu-item"
                  style={{ height: 28, color: "var(--lx-text-link)" }}
                  onClick={() => setModelsOpen(false)}
                >
                  Use &quot;{model || "my-custom-model-id"}&quot; anyway (free text)
                </button>
                <div className="flex justify-end" style={{ padding: "2px 4px" }}>
                  <button type="button" className="btn btn-ghost btn-icon-sm" aria-label="Close model list" onClick={() => { setModelsOpen(false); setModelFilter(""); }}>
                    <X size={12} strokeWidth={1.5} />
                  </button>
                </div>
              </div>
              );
            })()}
          </div>
          <div className="field-hint">Fetch lists models from the provider using the form's current (unsaved) values — OpenAI wire: GET {"{base}"}/models; Anthropic wire: GET {"{base}"}/v1/models with x-api-key + anthropic-version. Pick from the dropdown or type any id free-text; manual entry always available because some compat endpoints lack the route.</div>
          {fetchModels.isError && (
            <div className="field-hint field-hint-danger">Couldn't list models — check base URL / key. You can still save a hand-typed model id.</div>
          )}
        </div>

        {/* Thinking effort (settings-project-herald.html) */}
        <div className="field">
          <label className="field-label" htmlFor="herald-reasoning-effort">Thinking effort</label>
          <select
            id="herald-reasoning-effort"
            className="prop-input"
            aria-label="Thinking effort"
            value={reasoningEffort}
            onChange={(e) => setReasoningEffort(e.target.value as HeraldReasoningEffort | "")}
            style={{ width: 200, height: 32, fontSize: 12 }}
          >
            <option value="">Default (none set)</option>
            <option value="minimal">Minimal</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
          <div className="field-hint">Requests more or less reasoning from the model. Models that ignore it are unaffected.</div>
        </div>

        {/* Vision — folded into provider config (no standalone section) */}
        <div className="field">
          <label className="field-label">Primary model vision</label>
          <label className="check-row" style={{ cursor: "pointer", display: "inline-flex", alignItems: "flex-start", gap: 4 }}>
            <input
              type="checkbox"
              checked={supportsImages}
              onChange={(e) => setSupportsImages(e.target.checked)}
              aria-label="Primary model accepts images directly"
            />
            <span className="text-sm text-lx-text-secondary">&nbsp;Primary model accepts images directly (inline image parts)</span>
          </label>
          <div className="field-hint">Tick when the configured model is multimodal — images ride inline in the same request, no second provider needed.</div>
        </div>

        {/* Vision model */}
        <div className="field">
          <label className="field-label" htmlFor="herald-vision-model">Vision model</label>
          <div style={{ position: "relative", maxWidth: 480 }}>
            <div className="flex items-center gap-2">
              <input
                id="herald-vision-model"
                className="prop-input flex-1 font-mono"
                type="text"
                value={visionModel}
                onChange={(e) => setVisionModel(e.target.value)}
                placeholder="vision model id…"
              />
              <button type="button" className="btn btn-ghost btn-sm" style={{ flexShrink: 0 }} onClick={handleFetchModels} disabled={fetchModels.isPending || !baseUrl.trim()}>
                <RefreshCw size={12} strokeWidth={1.5} className={fetchModels.isPending ? "animate-spin" : undefined} />
                Fetch models
              </button>
            </div>
            {visionModelsOpen && (() => {
              const allModels = fetchModels.data?.models ?? [];
              const visible = allModels.filter((m) => m.id.toLowerCase().includes(visionModelFilter.toLowerCase()));
              return (
              <div className="menu" style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 30, padding: 8, display: "flex", flexDirection: "column", gap: 2 }}>
                <div className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]" style={{ padding: "4px 8px" }}>Fetched from provider · GET {"{base}"}/models</div>
                <input
                  className="prop-input w-full font-mono"
                  type="text"
                  value={visionModelFilter}
                  onChange={(e) => setVisionModelFilter(e.target.value)}
                  placeholder="Search models…"
                  aria-label="Search vision models"
                  style={{ height: 28, fontSize: 12, marginBottom: 4 }}
                />
                <div style={{ maxHeight: 264, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
                {visible.length === 0 ? (
                  <div className="text-xs text-lx-text-muted" style={{ padding: "8px 8px" }}>No models match &quot;{visionModelFilter}&quot;</div>
                ) : visible.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className="menu-item font-mono"
                    style={{
                      height: 28,
                      fontSize: 12,
                      justifyContent: "space-between",
                      ...(visionModel === m.id ? { background: "var(--lx-surface-selected)", color: "var(--lx-text-primary)" } : {}),
                    }}
                    onClick={() => { setVisionModel(m.id); setVisionModelsOpen(false); setVisionModelFilter(""); }}
                  >
                    <span>{m.id}</span>
                    {visionModel === m.id && <Check size={12} strokeWidth={2.5} />}
                  </button>
                ))}
                </div>
                <div className="font-micro text-2xs text-lx-text-muted" style={{ padding: "4px 8px" }}>{visible.length} of {allModels.length} models</div>
                <div className="menu-separator" style={{ margin: "4px 0" }} />
                <button
                  type="button"
                  className="menu-item"
                  style={{ height: 28, color: "var(--lx-text-link)" }}
                  onClick={() => setVisionModelsOpen(false)}
                >
                  Use &quot;{visionModel || "my-custom-model-id"}&quot; anyway (free text)
                </button>
                <div className="flex justify-end" style={{ padding: "2px 4px" }}>
                  <button type="button" className="btn btn-ghost btn-icon-sm" aria-label="Close vision model list" onClick={() => { setVisionModelsOpen(false); setVisionModelFilter(""); }}>
                    <X size={12} strokeWidth={1.5} />
                  </button>
                </div>
              </div>
              );
            })()}
          </div>
          <div className="field-hint">Used for internal analyze_image delegation — the tool frame is suppressed from member UI.</div>
          <div className="field-hint">
            Resolution order: primary supports images → inline; vision model set → delegated analysis; neither → attachments disabled with <span className="font-mono">VISION_NOT_CONFIGURED</span>.
          </div>
        </div>

        {/* Web search */}
        <div className="field">
          <label className="field-label">Web search</label>
          <div className="flex items-center gap-2" style={{ flexWrap: "wrap" }}>
            <select
              className="prop-input"
              aria-label="Search provider"
              value={searchProvider}
              onChange={(e) => setSearchProvider(e.target.value === "exa" ? "exa" : "none")}
              style={{ width: 200, height: 32, fontSize: 12 }}
            >
              <option value="exa">Exa</option>
              <option value="none">None (web_search disabled)</option>
            </select>
            {settings?.hasSearchKey && !replacingSearchKey ? (
              <input className="prop-input font-mono" type="password" value={settings.searchProvider === "exa" ? "saved" : ""} readOnly aria-label="Saved Exa API key (masked)" style={{ width: 240, height: 32, fontSize: 12 }} />
            ) : (
              <input
                className="prop-input font-mono"
                type="password"
                placeholder={settings?.hasSearchKey ? "Replace Exa API key…" : "Exa API key…"}
                value={searchApiKey}
                onChange={(e) => setSearchApiKey(e.target.value)}
                aria-label="Exa API key"
                style={{ width: 240, height: 32, fontSize: 12 }}
              />
            )}
          </div>
          <div className="field-hint">Enables the web_search tool (top-k 5, title+url+snippet only). "None" keeps Herald offline-search-only; fetch_url still works within the allowlist.</div>
        </div>

        {/* URL allowlist */}
        <div className="field">
          <label className="field-label" htmlFor="herald-allowlist">
            URL allowlist <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]" style={{ marginLeft: 6 }}>fetch_url guard</span>
          </label>
          <input id="herald-allowlist" className="prop-input w-full font-mono" type="text" value={urlAllowlist} onChange={(e) => setUrlAllowlist(e.target.value)} placeholder="docs.github.com, developer.mozilla.org" style={{ maxWidth: 480 }} />
          <div className="field-hint">Comma-separated hostnames (suffix match). Empty = all hosts allowed. Enforced on every redirect hop of fetch_url.</div>
        </div>

        {/* Test connection: pending / ok / fail variants */}
        <div className="field">
          <label className="field-label">Test connection</label>
          <div className="flex items-start gap-3" style={{ flexWrap: "wrap" }}>
            <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: "center" }} onClick={handleTest} disabled={test.isPending || !baseUrl.trim() || !model.trim()}>
              <Zap size={12} strokeWidth={1.5} />
              Test connection
            </button>
            {testState === "pending" && (
              <div className="card-row card-row--neutral" style={{ width: 220 }}>
                <div className="flex items-center gap-2">
                  <span className="spinner" />
                  <span className="text-xs font-medium text-lx-text-primary">Testing…</span>
                </div>
                <div className="text-xs text-lx-text-secondary mt-1">Minimal completion ping (+ Exa ping when set)</div>
              </div>
            )}
            {testState === "ok" && (
              <div className="card-row card-row--success" style={{ width: 220 }}>
                <div className="flex items-center gap-2">
                  <Check size={14} strokeWidth={2.5} color="var(--lx-text-success)" />
                  <span className="text-xs font-medium text-lx-text-primary">OK · {test.data?.latencyMs ?? 0} ms</span>
                </div>
                <div className="text-xs text-lx-text-secondary mt-1">Provider reachable · key valid</div>
              </div>
            )}
            {testState === "fail" && (
              <div className="card-row card-row--danger" style={{ width: 220 }}>
                <div className="flex items-center gap-2">
                  <X size={14} strokeWidth={2} color="var(--lx-text-danger)" />
                  <span className="text-xs font-medium text-lx-text-danger font-mono">{(test.error as { code?: string })?.code ?? "PROVIDER_UNREACHABLE"}</span>
                </div>
                <div className="text-xs text-lx-text-secondary mt-1">{(test.error as Error)?.message ?? "Check base URL / key."}</div>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between mt-5" style={{ borderTop: "1px solid var(--lx-border-subtle)", paddingTop: 16 }}>
          <span className="field-hint">Omitted key fields keep stored values. Saving with no provider row yet creates it; enqueue without a row fails PROVIDER_NOT_CONFIGURED.</span>
          <button type="button" className="btn btn-primary" onClick={handleSave} disabled={save.isPending || !baseUrl.trim() || !model.trim()}>
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </section>
  );
}

export function ProjectMemorySection({ projectId }: { projectId: string }) {
  const { data: memories = [], isLoading } = useHeraldMemory(projectId);
  const addMemory = useAddHeraldMemory(projectId);
  const removeMemory = useRemoveHeraldMemory(projectId);
  const [draft, setDraft] = useState("");

  const handleAdd = () => {
    if (!draft.trim()) return;
    addMemory.mutate(draft.trim(), { onSuccess: () => setDraft("") });
  };

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-display text-lg font-medium text-lx-text-primary">Project memory</h2>
        <span className="text-xs text-lx-text-muted">Per project</span>
      </div>
      <p className="text-sm text-lx-text-secondary mb-4" style={{ maxWidth: 640 }}>
        Curated facts Herald should always know: decisions, constraints, preferences. At enqueue time the top terms of the task title + description FTS-match up to 5 entries (2000-char cap) into the system prompt. Task data does not belong here.
      </p>

      <div className="card-panel card-panel--elevated">
        {isLoading ? (
          <div className="skeleton" style={{ height: 80 }} />
        ) : memories.length === 0 ? (
          <div className="empty-box" style={{ padding: "20px 16px" }}>
            <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} style={{ color: "var(--lx-text-muted)" }}>
              <path d="M12 8a4 4 0 0 1 4 4" />
              <path d="M20 16.58A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 4 15.25" />
              <path d="M8 16h.01" />
              <path d="M8.5 19h7" />
            </svg>
            <div className="text-sm font-medium text-lx-text-primary mt-1">No memories yet</div>
            <p className="text-xs text-lx-text-secondary" style={{ maxWidth: 360 }}>Add project conventions Herald should respect in every run. Leave empty to run without injected memory.</p>
          </div>
        ) : (
          <div className="flex flex-col" style={{ gap: 8 }}>
            {memories.map((memory) => (
              <MemoryRow key={memory.id} memory={memory} onDelete={() => removeMemory.mutate(memory.id)} deleting={removeMemory.isPending && removeMemory.variables === memory.id} />
            ))}
          </div>
        )}

        {/* Add form stays visible in every state (stable page structure). */}
        <div className="mt-4" style={{ borderTop: "1px solid var(--lx-border-subtle)", paddingTop: 16 }}>
          <div className="flex items-center gap-2" style={{ flexWrap: "wrap" }}>
            <input
              className="prop-input flex-1"
              type="text"
              placeholder="Add a fact, constraint, or preference…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
              aria-label="Add a fact, constraint, or preference"
              style={{ minWidth: 280 }}
            />
            <button type="button" className="btn btn-primary btn-sm" onClick={handleAdd} disabled={addMemory.isPending || !draft.trim()}>
              <Plus size={12} strokeWidth={1.5} />
              Add
            </button>
          </div>
          <div className="field-hint">One fact per entry, phrased as a standing rule. Entries are matched by meaning at enqueue time, not quoted verbatim.</div>
        </div>
      </div>
    </section>
  );
}

function MemoryRow({ memory, onDelete, deleting }: { memory: HeraldMemoryEntry; onDelete: () => void; deleting: boolean }) {
  const isHerald = memory.source === "herald";
  return (
    <div className="card-row" style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
      <div className="flex-1">
        <div className="text-sm text-lx-text-primary" style={{ lineHeight: "18px" }}>{memory.content}</div>
        <div className="flex items-center gap-2 mt-1">
          <span
            className="agent-tag"
            style={isHerald ? { background: "var(--lx-bg-accent-subtle)", color: "var(--lx-text-link)", borderColor: "rgba(240,192,64,0.25)" } : undefined}
          >
            {memory.source}
          </span>
          <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">
            {isHerald ? `saved by Herald · ${formatRelative(memory.updatedAt)}` : `updated ${formatRelative(memory.updatedAt)}`}
          </span>
        </div>
      </div>
      <button type="button" className="btn btn-danger btn-icon-sm" title="Delete memory" aria-label={`Delete memory: ${memory.content}`} onClick={onDelete} disabled={deleting}>
        <Trash2 size={14} strokeWidth={1.5} />
      </button>
    </div>
  );
}

// ── Engine section (settings-project-herald.html) ──

export function HeraldEngineSection({ project }: { project: Project }) {
  const { data: settings } = useHeraldSettings(project.id);
  const save = useSaveHeraldSettings(project.id);
  const [engine, setEngine] = useState<HearthEngine>("herald");
  const [switcher, setSwitcher] = useState(false);
  const [hydratedProjectId, setHydratedProjectId] = useState<string | null>(null);

  useEffect(() => {
    if (settings && hydratedProjectId !== project.id) {
      setEngine(settings.engine);
      setSwitcher(settings.engineSwitcherEnabled);
      setHydratedProjectId(project.id);
    }
  }, [settings, project.id, hydratedProjectId]);

  // Controls persist immediately (PUT with the stored base fields); the
  // mutation response refreshes the settings cache via setQueryData.
  const persist = (patch: Partial<HeraldSettingsInput>) => {
    if (!settings) return;
    save.mutate({ ...storedBaseInput(settings), ...patch });
  };

  const optionStyle = (selected: boolean): React.CSSProperties => ({
    height: 24,
    padding: "0 12px",
    fontSize: 12,
    ...(selected
      ? { background: "var(--lx-surface-selected)", borderColor: "var(--lx-border-focus)", color: "var(--lx-text-primary)" }
      : { color: "var(--lx-text-secondary)" }),
  });

  return (
    <section className="mb-8">
      <h2 className="font-display text-lg font-medium text-lx-text-primary mb-3">Engine</h2>
      <p className="text-sm text-lx-text-secondary mb-4" style={{ maxWidth: 640 }}>
        Which execution tier document threads and Generate use for this project: Herald (server-side writing assistant) or Blacksmith (daemon coding agent). Freeform chat always runs the Herald lane.
      </p>

      <div className="card-panel card-panel--elevated">
        <div className="field">
          <label className="field-label">Default engine</label>
          <div
            className="flex items-center"
            role="radiogroup"
            aria-label="Default engine"
            style={{ background: "var(--lx-surface-input)", border: "1px solid var(--lx-border-default)", borderRadius: 6, padding: 2, width: "max-content" }}
          >
            <button type="button" role="radio" aria-checked={engine === "herald"} className="btn btn-sm" style={optionStyle(engine === "herald")} onClick={() => { setEngine("herald"); persist({ engine: "herald" }); }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
              </svg>
              Herald
            </button>
            <button type="button" role="radio" aria-checked={engine === "blacksmith"} className="btn btn-sm" style={optionStyle(engine === "blacksmith")} onClick={() => { setEngine("blacksmith"); persist({ engine: "blacksmith" }); }} disabled={!settings}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0z" />
              </svg>
              Blacksmith
            </button>
          </div>
          <div className="field-hint">Applies to document threads + Generate as soon as it is saved. Blacksmith additionally requires a claim-eligible runtime online (NO_RUNTIME_ONLINE 409 otherwise).</div>
        </div>

        <div className="field">
          <label className="field-label">Show engine switcher to members</label>
          <div className="flex items-center gap-3">
            <button
              type="button"
              role="switch"
              aria-checked={switcher}
              aria-label={switcher ? "Engine switcher on" : "Engine switcher off"}
              className={cn("toggle-switch", switcher && "is-on")}
              onClick={() => { const next = !switcher; setSwitcher(next); persist({ engineSwitcherEnabled: next }); }}
            />
            <span className="text-sm text-lx-text-secondary">Members get a personal Herald | Blacksmith toggle in the Hearth popover header</span>
          </div>
          <div className="field-hint">Off (default) = members never see a toggle; every run uses the default engine above.</div>
        </div>

        <div className="text-xs text-lx-text-secondary" style={{ border: "1px solid var(--lx-border-default)", borderRadius: 6, padding: "10px 12px", maxWidth: 640, lineHeight: "18px" }}>
          <strong className="font-medium text-lx-text-primary">Chat gate.</strong> Freeform chat ALWAYS runs the Herald lane regardless of this setting; under engine=&apos;blacksmith&apos; chat streams fail with <span className="font-mono">ENGINE_NOT_SUPPORTED_FOR_CHAT</span> (409).
        </div>
      </div>
    </section>
  );
}

// ── Agent skill availability (settings-project-herald.html) ──

function AgentSkillColumn({ agentId, agents, skills, onToggle }: {
  agentId: string;
  agents: { id: string; name: string; skillIds: string[] }[];
  skills: { id: string; name: string }[];
  onToggle: (agentId: string, skillIds: string[]) => void;
}) {
  const agent = agents.find((a) => a.id === agentId);
  const attached = new Set(agent?.skillIds ?? []);
  if (!agent) return null;
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <span className="text-sm font-medium text-lx-text-primary">{agent.name}</span>
        <span className="font-micro text-2xs uppercase tracking-[0.04em]" style={{ background: "var(--lx-bg-accent-subtle)", color: "var(--lx-text-link)", padding: "2px 8px", borderRadius: 9999, fontSize: 10 }}>builtin</span>
      </div>
      <div style={{ background: "var(--lx-surface-input)", border: "1px solid var(--lx-border-default)", borderRadius: 6, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
        {skills.map((skill) => (
          <label key={skill.id} className="check-row" style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
            <input
              type="checkbox"
              checked={attached.has(skill.id)}
              onChange={(e) => {
                const next = e.target.checked ? [...attached, skill.id] : [...attached].filter((id) => id !== skill.id);
                onToggle(agent.id, next);
              }}
              aria-label={`${skill.name} — ${agent.name}`}
            />
            <span className="text-sm text-lx-text-secondary">&nbsp;{skill.name}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

export function AgentSkillAvailabilitySection({ projectId }: { projectId: string }) {
  const { data: agents = [] } = useAgents();
  const { data: skills = [] } = useSkills();
  const replaceSkills = useReplaceAgentSkills();

  // Checkbox writes PUT /api/forge/agents/:id/skills immediately (junction
  // insert/delete); the mutation response refreshes the agents cache via
  // setQueryData.
  const handleToggle = (agentId: string, skillIds: string[]) => {
    replaceSkills.mutate({ id: agentId, skillIds });
  };

  return (
    <section className="mb-8">
      <h2 className="font-display text-lg font-medium text-lx-text-primary mb-3">Agent skill availability</h2>
      <p className="text-sm text-lx-text-secondary mb-4" style={{ maxWidth: 640 }}>
        Which skills each builtin agent offers. Availability is junction rows only — no JSON columns on the agent rows. Popover and chat skill chips filter to the active engine agent&apos;s list.
      </p>

      <div className="card-panel card-panel--elevated">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
          <AgentSkillColumn agentId={ENGINE_AGENT_IDS.herald} agents={agents} skills={skills} onToggle={handleToggle} />
          <AgentSkillColumn agentId={ENGINE_AGENT_IDS.blacksmith} agents={agents} skills={skills} onToggle={handleToggle} />
        </div>
        <div className="field-hint" style={{ marginTop: 10 }}>
          Checkbox writes apply immediately. An agent with zero attached skills can&apos;t generate — the popover shows its empty-skills state with Generate disabled. Both agents are editable + Reset-to-default in Settings → Agents &amp; Skills; never deletable.
        </div>
      </div>
    </section>
  );
}
