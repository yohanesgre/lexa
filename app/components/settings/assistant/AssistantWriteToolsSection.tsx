import { useEffect, useRef, useState } from "react";
import { useAssistantSettings, useSaveAssistantWriteTools } from "../../../lib/queries";
import { ASSISTANT_WRITE_TOOL_NAMES } from "../../../../shared/assistant";
import type { Project } from "../../../../shared/types";

// ── Write tools (assistant-write-approvals.html State 4) ──
// Which mutating tools Assistant may propose at all. One stored field
// (write_tools): master OFF = empty array; EMPTY SELECTION = writes off —
// behaves exactly like master off. The composer's per-thread Writes mode
// (Ask / Auto / Blocked) decides whether a proposed write executes.

export function AssistantWriteToolsSection({ project }: { project: Project }) {
  const { data: settings, isLoading, isError } = useAssistantSettings(project.id);
  const save = useSaveAssistantWriteTools(project.id);
  const [selected, setSelected] = useState<string[]>([]);
  const hydratedRef = useRef<string | null>(null);

  useEffect(() => {
    if (settings && hydratedRef.current !== project.id) {
      hydratedRef.current = project.id;
      setSelected(settings.writeTools.filter((t) => (ASSISTANT_WRITE_TOOL_NAMES as readonly string[]).includes(t)));
    }
  }, [settings, project.id]);

  const enabled = selected.length > 0;

  const storedTools = (settings?.writeTools ?? []).filter((t) => (ASSISTANT_WRITE_TOOL_NAMES as readonly string[]).includes(t));
  const isDirty = selected.length !== storedTools.length || selected.some((t) => !storedTools.includes(t));

  const toggleTool = (tool: string) =>
    setSelected((prev) => (prev.includes(tool) ? prev.filter((t) => t !== tool) : [...prev, tool]));

  // Master OFF clears the list (empty array IS writes off). Master ON from
  // empty restores the full default set — there is no stored "previous"
  // selection to return to.
  const toggleMaster = () => setSelected((prev) => (prev.length > 0 ? [] : [...ASSISTANT_WRITE_TOOL_NAMES]));

  const handleSave = () => {
    if (!settings || !isDirty) return;
    save.mutate({
      searchProvider: settings.searchProvider,
      urlAllowlist: settings.urlAllowlist,
      primarySupportsImages: settings.primarySupportsImages,
      reasoningEffort: settings.reasoningEffort,
      providerId: settings.providerId,
      modelId: settings.modelId,
      fallbackModelIds: [...(settings.fallbackModelIds ?? [])],
      writeTools: selected,
    });
  };

  if (isError) {
    return (
      <section className="mb-8">
        <h2 className="font-display text-lg font-medium text-lx-text-primary mb-3">Write tools</h2>
        <div className="text-sm text-lx-text-danger py-6 text-center" role="alert">Failed to load write tools.</div>
      </section>
    );
  }

  // No provider row yet — PUT needs kind/baseUrl/model, so this section stays
  // hidden until the provider is configured.
  if (isLoading || !settings) {
    return null;
  }

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-display text-lg font-medium text-lx-text-primary">Write tools</h2>
        <span className="text-xs text-lx-text-muted">Per project</span>
      </div>
      <p className="text-sm text-lx-text-secondary mb-4" style={{ maxWidth: 640 }}>
        Which mutating tools Assistant may propose at all. This project gate decides what may be PROPOSED; the composer&apos;s Writes mode (Ask / Auto / Blocked) decides whether a proposed write executes. Read tools are unaffected by either gate.
      </p>

      <div className="card-panel card-panel--elevated">
        {/* Master toggle */}
        <div className="field">
          <div className="flex items-center gap-3">
            <button type="button" className={`toggle-switch${enabled ? " is-on" : ""}`} aria-label="Write tools enabled" aria-pressed={enabled} onClick={toggleMaster} />
            <span className="text-sm font-medium text-lx-text-primary">Write tools enabled</span>
          </div>
          <div className="field-hint">Master gate for all mutating Assistant tools. Off — Assistant never proposes writes and the per-tool list below is ignored. Master OFF wins in every composer mode; changes apply from the next turn — a suspended batch finishes under the mode it started with.</div>
        </div>

        {/* Per-tool checkboxes */}
        <div className="field">
          <span className="field-label">
            Allowed tools{" "}
            <span className="font-micro text-2xs text-lx-text-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em", marginLeft: 6 }}>
              {ASSISTANT_WRITE_TOOL_NAMES.length} write tools
            </span>
          </span>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 24px", background: "var(--lx-surface-input)", border: "1px solid var(--lx-border-default)", borderRadius: 6, padding: "10px 12px" }}>
            {ASSISTANT_WRITE_TOOL_NAMES.map((tool) => (
              <label key={tool} className="check-row" style={{ cursor: "pointer" }}>
                <input type="checkbox" checked={selected.includes(tool)} onChange={() => toggleTool(tool)} aria-label={tool} style={{ position: "absolute", opacity: 0, width: 14, height: 14 }} />
                <div className={`checkbox${selected.includes(tool) ? " checked" : ""}`} aria-hidden="true" />
                <span className={`font-mono text-xs${selected.includes(tool) ? " text-lx-text-primary" : " text-lx-text-secondary"}`}>{tool}</span>
              </label>
            ))}
          </div>
          <div className="field-hint">Unticked tools are invisible to Assistant — it can neither call them nor propose writes with them.</div>
        </div>

        <div className="responsive-note" style={{ maxWidth: 640 }}>
          <strong>Two gates, three modes.</strong> This settings list decides what Assistant MAY propose. The composer&apos;s{" "}
          <span className="font-mono">Writes</span> mode decides what actually HAPPENS, per chat thread:{" "}
          <strong>Ask</strong> — the model proposes, the turn suspends, chips ask per change, and only an approve resumes and executes;{" "}
          <strong>Auto</strong> — every write the project gate allows executes immediately, with no proposal chips and no suspend;{" "}
          <strong>Blocked</strong> — writes are refused, the model is told reads still work, and the reply suggests switching modes. A ticked tool can still be refused by the composer mode, and an unticked tool can never be proposed in any mode. Read tools are unaffected everywhere.
        </div>

        <div className="flex items-center justify-between mt-5" style={{ borderTop: "1px solid var(--lx-border-subtle)", paddingTop: 16 }}>
          <span className="field-hint">Empty selection = read-only. Applies from the next turn.</span>
          <button type="button" className="btn btn-primary" onClick={handleSave} disabled={save.isPending || !isDirty}>
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </section>
  );
}
