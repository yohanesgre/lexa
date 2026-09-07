import { useEffect, useRef, useState } from "react";
import { cn } from "../../ui/cn";
import type { HearthEngine } from "../../../../shared/herald";
import { useHeraldSettings, useSaveHeraldSettings } from "../../../lib/queries";
import type { HeraldSettingsMasked, HeraldSettingsInput } from "../../../../shared/herald";
import type { Project } from "../../../../shared/types";

// PUT requires kind/baseUrl/model — partial saves (engine) ride on the
// stored masked values so only the touched fields actually change.
function storedBaseInput(settings: HeraldSettingsMasked): HeraldSettingsInput {
  return { kind: settings.kind, baseUrl: settings.baseUrl, model: settings.model } as HeraldSettingsInput;
}

const OPTION_BASE_STYLE: React.CSSProperties = { height: 24, padding: "0 12px", fontSize: 12 };
const OPTION_SELECTED_STYLE: React.CSSProperties = {
  background: "var(--lx-surface-selected)",
  borderColor: "var(--lx-border-focus)",
  color: "var(--lx-text-primary)",
};
const OPTION_UNSELECTED_STYLE: React.CSSProperties = { color: "var(--lx-text-secondary)" };
const optionStyle = (selected: boolean): React.CSSProperties =>
  selected ? { ...OPTION_BASE_STYLE, ...OPTION_SELECTED_STYLE } : { ...OPTION_BASE_STYLE, ...OPTION_UNSELECTED_STYLE };

export function HeraldEngineSection({ project }: { project: Project }) {
  const { data: settings } = useHeraldSettings(project.id);
  const save = useSaveHeraldSettings(project.id);
  const [engine, setEngine] = useState<HearthEngine>("herald");
  const [switcher, setSwitcher] = useState(false);
  const hydratedRef = useRef<string | null>(null);

  useEffect(() => {
    if (settings && hydratedRef.current !== project.id) {
      hydratedRef.current = project.id;
      setEngine(settings.engine);
      setSwitcher(settings.engineSwitcherEnabled);
    }
  }, [settings, project.id]);

  // Controls persist immediately (PUT with the stored base fields); the
  // mutation response refreshes the settings cache via setQueryData.
  const persist = (patch: Partial<HeraldSettingsInput>) => {
    if (!settings) return;
    save.mutate({ ...storedBaseInput(settings), ...patch });
  };

  return (
    <section className="mb-8">
      <h2 className="font-display text-lg font-medium text-lx-text-primary mb-3">Engine</h2>
      <p className="text-sm text-lx-text-secondary mb-4" style={{ maxWidth: 640 }}>
        Which execution tier document threads and Generate use for this project: Herald (server-side writing assistant) or Blacksmith (daemon coding agent). Freeform chat always runs the Herald lane.
      </p>

      <div className="card-panel card-panel--elevated">
        <div className="field">
          <span className="field-label">Default engine</span>
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
          <span className="field-label">Show engine switcher to members</span>
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
