import { useEffect, useRef, useState } from "react";
import { Check, EyeOff, Plus, RefreshCw, Trash2, X, Zap } from "lucide-react";
import type { ProviderKind } from "../../../shared/herald";
import {
  useHeraldSettings,
  useSaveHeraldSettings,
  useTestHeraldSettings,
  useFetchHeraldModels,
  useHeraldMemory,
  useAddHeraldMemory,
  useRemoveHeraldMemory,
} from "../../lib/queries";
import type { HeraldMemoryEntry } from "../../lib/api";
import { formatRelative } from "../../lib/relative-time";
import type { Project } from "../../../shared/types";

// Per-project Herald provider + memory curation — transcribed from
// wireframes/src/settings-project-herald.html. Keys are write-only: the GET
// returns a masked view and PUT omits untouched key fields (stored values
// kept server-side).

export function HeraldProviderSection({ project }: { project: Project }) {
  const { data: settings, isLoading } = useHeraldSettings(project.id);
  const save = useSaveHeraldSettings(project.id);
  const test = useTestHeraldSettings(project.id);
  const fetchModels = useFetchHeraldModels(project.id);

  const [kind, setKind] = useState<ProviderKind>("openai_compatible");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [searchProvider, setSearchProvider] = useState<"exa" | "none">("exa");
  const [replacingSearchKey, setReplacingSearchKey] = useState(false);
  const [searchApiKey, setSearchApiKey] = useState("");
  const [urlAllowlist, setUrlAllowlist] = useState("");
  const [modelsOpen, setModelsOpen] = useState(false);
  const [hydratedProjectId, setHydratedProjectId] = useState<string | null>(null);

  // Hydrate the form once per project from the masked view.
  useEffect(() => {
    if (settings && hydratedProjectId !== project.id) {
      setKind(settings.kind);
      setBaseUrl(settings.baseUrl);
      setModel(settings.model);
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
      onSuccess: () => setModelsOpen(true),
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
        Herald (the writing assistant in the Forge popover) runs against an OpenAI-compatible or Anthropic-compatible endpoint. Keys live server-side only and are never serialized back to the browser.
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
            {modelsOpen && (
              <div className="menu" style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 30, padding: 8, display: "flex", flexDirection: "column", gap: 2 }}>
                <div className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]" style={{ padding: "4px 8px" }}>Fetched from provider · GET {"{base}"}/models</div>
                {(fetchModels.data?.models ?? []).map((m) => (
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
                  <button type="button" className="btn btn-ghost btn-icon-sm" aria-label="Close model list" onClick={() => setModelsOpen(false)}>
                    <X size={12} strokeWidth={1.5} />
                  </button>
                </div>
              </div>
            )}
          </div>
          <div className="field-hint">Fetch lists models from the provider using the form's current (unsaved) values — OpenAI wire: GET {"{base}"}/models; Anthropic wire: GET {"{base}"}/v1/models with x-api-key + anthropic-version. Pick from the dropdown or type any id free-text; manual entry always available because some compat endpoints lack the route.</div>
          {fetchModels.isError && (
            <div className="field-hint field-hint-danger">Couldn't list models — check base URL / key. You can still save a hand-typed model id.</div>
          )}
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
