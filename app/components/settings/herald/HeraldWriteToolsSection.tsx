import { useEffect, useRef, useState } from "react";
import { useHeraldSettings, useSaveHeraldWriteTools } from "../../../lib/queries";
import type { HeraldSettingsInput } from "../../../../shared/herald";
import type { Project } from "../../../../shared/types";

// ── Write tools (herald-write-approvals.html State 4) ──
// Which mutating tools Herald may propose at all. One stored field
// (write_tools): master OFF = empty array; EMPTY SELECTION = writes off —
// behaves exactly like master off. Every proposed write still requires
// explicit per-change approval in chat.
const HERALD_WRITE_TOOLS = [
  "create_task",
  "update_task",
  "move_task",
  "archive_task",
  "restore_task",
  "add_comment",
  "create_wiki_page",
  "edit_wiki_page",
  "create_milestone",
  "update_milestone",
  "archive_milestone",
  "create_sprint",
  "update_sprint",
] as const;

export function HeraldWriteToolsSection({ project }: { project: Project }) {
  const { data: settings, isLoading } = useHeraldSettings(project.id);
  const save = useSaveHeraldWriteTools(project.id);
  const [selected, setSelected] = useState<string[]>([]);
  const hydratedRef = useRef<string | null>(null);

  useEffect(() => {
    if (settings && hydratedRef.current !== project.id) {
      hydratedRef.current = project.id;
      setSelected(settings.writeTools.filter((t) => (HERALD_WRITE_TOOLS as readonly string[]).includes(t)));
    }
  }, [settings, project.id]);

  const enabled = selected.length > 0;

  const toggleTool = (tool: string) =>
    setSelected((prev) => (prev.includes(tool) ? prev.filter((t) => t !== tool) : [...prev, tool]));

  // Master OFF clears the list (empty array IS writes off). Master ON from
  // empty restores the full default set — there is no stored "previous"
  // selection to return to.
  const toggleMaster = () => setSelected((prev) => (prev.length > 0 ? [] : [...HERALD_WRITE_TOOLS]));

  const handleSave = () => {
    if (!settings) return;
    save.mutate({
      ...(settings.kind !== undefined ? { kind: settings.kind } : {}),
      ...(settings.baseUrl !== undefined ? { baseUrl: settings.baseUrl } : {}),
      ...(settings.model !== undefined ? { model: settings.model } : {}),
      ...(settings.fallbackModelIds !== undefined ? { fallbackModelIds: [...settings.fallbackModelIds] } : {}),
      writeTools: selected,
    } as HeraldSettingsInput);
  };

  // No provider row yet — PUT needs kind/baseUrl/model, so this section stays
  // hidden until the provider is configured.
  if (isLoading || !settings) {
    return null;
  }

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-display text-lg font-medium text-lx-text-primary">Herald write tools</h2>
        <span className="text-xs text-lx-text-muted">Per project</span>
      </div>
      <p className="text-sm text-lx-text-secondary mb-4" style={{ maxWidth: 640 }}>
        Which mutating tools Herald may propose at all. Every proposed write still requires explicit per-change approval in chat — this gate only decides whether Herald can ask.
      </p>

      <div className="card-panel card-panel--elevated">
        {/* Master toggle */}
        <div className="field">
          <div className="flex items-center gap-3">
            <button type="button" className={`toggle-switch${enabled ? " is-on" : ""}`} aria-label="Write tools on" aria-pressed={enabled} onClick={toggleMaster} />
            <span className="text-sm font-medium text-lx-text-primary">Write tools enabled</span>
          </div>
          <div className="field-hint">Master gate for all mutating Herald tools. Off — Herald never proposes writes and the per-tool list below is ignored.</div>
        </div>

        {/* Per-tool checkboxes */}
        <div className="field">
          <span className="field-label">
            Allowed tools{" "}
            <span className="font-micro text-2xs text-lx-text-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em", marginLeft: 6 }}>
              13 write tools
            </span>
          </span>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 24px", background: "var(--lx-surface-input)", border: "1px solid var(--lx-border-default)", borderRadius: 6, padding: "10px 12px" }}>
            {HERALD_WRITE_TOOLS.map((tool) => (
              <label key={tool} className="check-row" style={{ cursor: "pointer" }}>
                <input type="checkbox" checked={selected.includes(tool)} onChange={() => toggleTool(tool)} aria-label={tool} style={{ position: "absolute", opacity: 0, width: 14, height: 14 }} />
                <div className={`checkbox${selected.includes(tool) ? " checked" : ""}`} aria-hidden="true" />
                <span className="text-sm text-lx-text-secondary">{tool.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")}</span>
              </label>
            ))}
          </div>
          <div className="field-hint">Unticked tools are invisible to Herald — it can neither call them nor propose writes with them.</div>
        </div>

        <div className="responsive-note" style={{ maxWidth: 640 }}>
          <strong>Two gates, always both.</strong> This settings list decides what Herald MAY propose; the in-chat approval chips decide what actually HAPPENS. There is no &quot;auto-approve&quot; anywhere — a ticked tool still suspends the turn and waits for a human decision on every single write.
        </div>

        <div className="flex items-center justify-between mt-5" style={{ borderTop: "1px solid var(--lx-border-subtle)", paddingTop: 16 }}>
          <span className="field-hint">Empty selection behaves exactly like master off — Herald runs read-only. Changes apply from the next turn onward.</span>
          <button type="button" className="btn btn-primary" onClick={handleSave} disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </section>
  );
}
