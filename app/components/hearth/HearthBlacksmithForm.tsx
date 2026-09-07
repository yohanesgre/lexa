import { useEffect, useState } from "react";
import { Flame } from "lucide-react";
import { formatSessionAge } from "../../lib/use-hearth-session";
import type { LexaSkill, Runtime } from "../../../shared/types";

// Blacksmith engine run form: skill chips, extra prompt + runtime picker,
// session continuation row, and the Generate row.
export function BlacksmithForm({ agentSkills, effectiveSkillId, setSkillId, extraPrompt, setExtraPrompt, runtimeId, setRuntimeId, onlineRuntimes, sessionRow, resetSession, documentType, documentId, taskRunning, selectionText, onGenerate, creating }: {
  agentSkills: LexaSkill[];
  effectiveSkillId: string;
  setSkillId: (v: string) => void;
  extraPrompt: string;
  setExtraPrompt: (v: string) => void;
  runtimeId: string;
  setRuntimeId: (v: string) => void;
  onlineRuntimes: Runtime[];
  sessionRow: { updatedAt: string } | null;
  resetSession: { mutate: (input: { documentType: "task" | "wiki"; documentId: string; runtimeId: string }) => void; isPending: boolean };
  documentType: "task" | "wiki";
  documentId: string;
  taskRunning: boolean;
  selectionText: string;
  onGenerate: () => void;
  creating: boolean;
}) {
  const [skillMenuOpen, setSkillMenuOpen] = useState(false);
  // Auto-select the first online runtime.
  useEffect(() => {
    if (runtimeId === "" && onlineRuntimes.length > 0) {
      setRuntimeId(onlineRuntimes[0]!.id);
    }
  }, [onlineRuntimes, runtimeId, setRuntimeId]);
  return (
    <>
      <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--lx-border-default)" }}>
        <span className="prop-label" style={{ display: "block", marginBottom: 6 }}>Skill</span>
        {agentSkills.length > 0 ? (
          renderChips(agentSkills, effectiveSkillId, setSkillId, (s) => s.name, (s) => s.id, skillMenuOpen, setSkillMenuOpen)
        ) : (
          <div style={{ background: "var(--lx-surface-input)", border: "1px solid var(--lx-border-default)", borderRadius: 6, padding: "8px 10px" }}>
            <span className="text-xs text-lx-text-muted">No skills attached — add them in Settings.</span>
          </div>
        )}
      </div>

      <PromptFields extraPrompt={extraPrompt} setExtraPrompt={setExtraPrompt} runtimeId={runtimeId} setRuntimeId={setRuntimeId} onlineRuntimes={onlineRuntimes} />

      <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--lx-border-default)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span className="text-xs text-lx-text-muted" style={{ fontSize: 11 }}>
          {sessionRow ? `Continuing session from ${formatSessionAge(sessionRow.updatedAt)}` : "New session"}
        </span>
        <button
          type="button"
          className="btn btn-ghost"
          style={{ height: 22, padding: "0 8px", fontSize: 11 }}
          onClick={() => resetSession.mutate({ documentType, documentId, runtimeId })}
          disabled={resetSession.isPending || taskRunning || !runtimeId}
          title={taskRunning ? "running task" : undefined}
        >
          New session
        </button>
      </div>

      <div style={{ padding: "10px 12px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">
          {selectionText ? `Selection: ${selectionText.length} chars` : "No selection"}
        </span>
        <button type="button" className="btn btn-primary" style={{ height: 28, padding: "0 12px", fontSize: 12 }} onClick={onGenerate} disabled={creating || onlineRuntimes.length === 0 || !effectiveSkillId}>
          <Flame size={12} strokeWidth={1.5} />
          {creating ? "Starting…" : "Generate"}
        </button>
      </div>
    </>
  );
}

const renderChips = <T,>(items: T[], selected: string | null, onSelect: (id: string) => void, label: (item: T) => string, idOf: (item: T) => string, restOpen: boolean, setRestOpen: (v: boolean) => void) => {
  const visible = items.length > 6 ? items.slice(0, 6) : items;
  const rest = items.length > 6 ? items.slice(6) : [];
  return (
    <div className="flex items-center gap-2" style={{ flexWrap: "wrap" }}>
      {visible.map((item) => (
        <button
          key={idOf(item)}
          type="button"
          className="btn btn-ghost"
          style={{
            height: 26, padding: "0 10px", fontSize: 12,
            borderColor: selected === idOf(item) ? "var(--lx-border-focus)" : undefined,
            color: selected === idOf(item) ? "var(--lx-text-primary)" : undefined,
          }}
          onClick={() => onSelect(idOf(item))}
        >
          {label(item)}
        </button>
      ))}
      {rest.length > 0 && (
        <div style={{ position: "relative" }}>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ height: 26, padding: "0 10px", fontSize: 12 }}
            aria-label="More options"
            onClick={() => setRestOpen(!restOpen)}
            aria-expanded={restOpen}
          >
            ⋯
          </button>
          {restOpen && (
            <div className="menu" style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 10, padding: 8, display: "flex", flexDirection: "column", gap: 2 }}>
              {rest.map((item) => (
                <button
                  key={idOf(item)}
                  type="button"
                  className="menu-item"
                  style={{ fontSize: 12, color: selected === idOf(item) ? "var(--lx-text-primary)" : undefined }}
                  onClick={() => {
                    onSelect(idOf(item));
                    setRestOpen(false);
                  }}
                >
                  {label(item)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

function PromptFields({ extraPrompt, setExtraPrompt, runtimeId, setRuntimeId, onlineRuntimes }: {
  extraPrompt: string;
  setExtraPrompt: (v: string) => void;
  runtimeId: string;
  setRuntimeId: (v: string) => void;
  onlineRuntimes: Runtime[];
}) {
  return (
    <>
      <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--lx-border-default)" }}>
        <span className="prop-label" style={{ display: "block", marginBottom: 6 }}>
          Additional prompt <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]" style={{ marginLeft: 4 }}>Optional</span>
        </span>
        <textarea
          className="prop-input w-full"
          rows={3}
          aria-label="Additional prompt"
          value={extraPrompt}
          onChange={(e) => setExtraPrompt(e.target.value)}
          placeholder="Extra instructions for this run…"
          style={{ fontSize: 12, lineHeight: 1.5, resize: "vertical" }}
        />
      </div>

      <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--lx-border-default)" }}>
        <span className="prop-label" style={{ display: "block", marginBottom: 6 }}>Runtime</span>
        <select
          className="prop-input w-full"
          aria-label="Runtime"
          value={runtimeId}
          onChange={(e) => setRuntimeId(e.target.value)}
          style={{ height: 28, fontSize: 12 }}
          disabled={onlineRuntimes.length === 0}
        >
          {onlineRuntimes.length === 0 ? (
            <option value="">No runtime online</option>
          ) : (
            onlineRuntimes.map((r) => (
              <option key={r.id} value={r.id}>{r.name} · {r.provider}</option>
            ))
          )}
        </select>
      </div>
    </>
  );
}
