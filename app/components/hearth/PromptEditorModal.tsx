import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { cn } from "../ui/cn";
import { useCreateHearthAgent, useCreateHearthSkill, useDeleteHearthAgent, useDeleteHearthSkill, useReplaceAgentSkills, useResetHearthAgent, useResetHearthSkill, useUpdateHearthAgent, useUpdateHearthSkill } from "../../lib/queries";
import type { LexaAgent, LexaSkill } from "../../../shared/types";

interface PromptEditorModalProps {
  kind: "agent" | "skill";
  entity: LexaAgent | LexaSkill | null;
  allSkills?: LexaSkill[];
  allAgents?: LexaAgent[];
  onClose: () => void;
}

// Settings editor for Hearth agents + skills (global rule bundles). The
// instructions become files in the run dir at claim time (AGENTS.md /
// .agents/<skill>/SKILL.md) — the preview shows exactly what ships.
export function PromptEditorModal({ kind, entity, allSkills = [], allAgents = [], onClose }: PromptEditorModalProps) {
  const isNew = entity === null;
  const isAgent = kind === "agent";
  const agent = isAgent ? (entity as LexaAgent | null) : null;
  const skill = !isAgent ? (entity as LexaSkill | null) : null;
  const isBuiltin = (isAgent ? agent?.isBuiltin : skill?.isBuiltin) ?? false;

  const [name, setName] = useState(entity?.name ?? "");
  const [description, setDescription] = useState(entity?.description ?? "");
  const [instructions, setInstructions] = useState(entity?.instructions ?? "");
  const [attachedSkillIds, setAttachedSkillIds] = useState<string[]>(agent?.skillIds ?? []);

  const createAgent = useCreateHearthAgent();
  const updateAgent = useUpdateHearthAgent();
  const deleteAgent = useDeleteHearthAgent();
  const replaceSkills = useReplaceAgentSkills();
  const resetAgent = useResetHearthAgent();
  const createSkill = useCreateHearthSkill();
  const updateSkill = useUpdateHearthSkill();
  const deleteSkill = useDeleteHearthSkill();
  const resetSkill = useResetHearthSkill();

  const dirty = entity === null || name !== entity.name || description !== entity.description || instructions !== entity.instructions;
  const skillsDirty = agent !== null && JSON.stringify([...attachedSkillIds].toSorted()) !== JSON.stringify([...agent.skillIds].toSorted());
  const canSave = name.trim().length > 0 && instructions.trim().length > 0 && (dirty || skillsDirty);
  const pending =
    createAgent.isPending || updateAgent.isPending || replaceSkills.isPending ||
    createSkill.isPending || updateSkill.isPending;

  useEffect(() => {
    if (!isAgent || !agent) return;
    setAttachedSkillIds(agent.skillIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity]);

  const handleSave = () => {
    if (!canSave) return;
    if (isAgent) {
      if (isNew) {
        createAgent.mutate({ name: name.trim(), description: description.trim(), instructions }, {
          onSuccess: (created) => {
            if (attachedSkillIds.length > 0) replaceSkills.mutate({ id: created.id, skillIds: attachedSkillIds });
            onClose();
          },
        });
      } else if (agent) {
        updateAgent.mutate({ id: agent.id, patch: { name: name.trim(), description: description.trim(), instructions } }, {
          onSuccess: () => {
            if (skillsDirty) replaceSkills.mutate({ id: agent.id, skillIds: attachedSkillIds });
            onClose();
          },
        });
      }
    } else if (isNew) {
      createSkill.mutate({ name: name.trim(), description: description.trim(), instructions }, { onSuccess: () => onClose() });
    } else if (skill) {
      updateSkill.mutate({ id: skill.id, patch: { name: name.trim(), description: description.trim(), instructions } }, { onSuccess: () => onClose() });
    }
  };

  const handleDelete = () => {
    if (!entity) return;
    if (!window.confirm(`Delete ${kind} '${entity.name}'? This cannot be undone.`)) return;
    if (isAgent) {
      deleteAgent.mutate(entity.id, { onSuccess: () => onClose() });
    } else {
      deleteSkill.mutate(entity.id, { onSuccess: () => onClose() });
    }
  };

  const handleReset = () => {
    if (!entity) return;
    if (isAgent) {
      resetAgent.mutate(entity.id, { onSuccess: () => onClose() });
    } else {
      resetSkill.mutate(entity.id, { onSuccess: () => onClose() });
    }
  };

  const attachedSet = new Set(attachedSkillIds);
  const attachedNames = allSkills.flatMap((s) => (attachedSet.has(s.id) ? [s.name] : []));

  return (
    <div className="modal dialog-enter" style={{ width: 600 }}>
      <div className="modal-header">
        <span className="modal-title">{isNew ? `New ${kind}` : `Edit ${kind} — ${entity!.name}`}</span>
        <button type="button" className="btn btn-ghost" style={{ width: 32, height: 32, padding: 0 }} onClick={onClose} aria-label="Close">
          <X size={16} strokeWidth={1.5} />
        </button>
      </div>

      <div className="modal-body">
        <div className="field">
          <label className="field-label" htmlFor="prompt-name">Name</label>
          <input id="prompt-name" className="prop-input w-full" type="text" value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="prompt-description">Description</label>
          <input id="prompt-description" className="prop-input w-full" type="text" value={description} onChange={(e) => setDescription(e.target.value)} />
          <div className="field-hint">Display-only — never sent to the runtime agent.</div>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="prompt-instructions">
            Instructions <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]" style={{ marginLeft: 6 }}>{isAgent ? "AGENTS.md" : "SKILL.md"}</span>
          </label>
          <textarea
            id="prompt-instructions"
            className="prop-input w-full font-mono"
            rows={7}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            style={{ fontSize: 12, lineHeight: 1.6, resize: "vertical" }}
          />
          <div className="field-hint">
            Written to the run dir as {isAgent ? <span className="font-mono">AGENTS.md</span> : <span className="font-mono">.agents/&lt;skill&gt;/SKILL.md</span>} at claim time. The runtime CLI reads it natively (opencode). Edits apply to the very next run — no host store, nothing to sync.
          </div>
        </div>

        {isAgent && (
          <div className="field">
            <span className="field-label">Attached skills</span>
            <div style={{ background: "var(--lx-surface-input)", border: "1px solid var(--lx-border-default)", borderRadius: 6, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
              {allSkills.length === 0 ? (
                <span className="text-xs text-lx-text-muted">No skills yet — create one in the Skills section.</span>
              ) : (
                allSkills.map((s) => (
                  <label key={s.id} className="flex items-center gap-2" style={{ cursor: "pointer", fontSize: 12, color: "var(--lx-text-secondary)" }}>
                    <input
                      type="checkbox"
                      checked={attachedSet.has(s.id)}
                      onChange={(e) =>
                        setAttachedSkillIds((prev) => (e.target.checked ? [...prev, s.id] : prev.filter((id) => id !== s.id)))
                      }
                    />
                    {s.name} <span className="text-xs text-lx-text-muted">— {s.description || "no description"}</span>
                  </label>
                ))
              )}
            </div>
            <div className="field-hint">The Hearth popover only offers skills attached here. An agent with none can't generate.</div>
          </div>
        )}

        {!isAgent && allAgents.length > 0 && (
          <div className="field">
            <span className="field-label">Used by</span>
            <div style={{ background: "var(--lx-surface-input)", border: "1px solid var(--lx-border-default)", borderRadius: 6, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
              {allAgents.filter((a) => a.skillIds.includes(skill?.id ?? "")).length === 0 ? (
                <span className="text-xs text-lx-text-muted">No agents use this skill yet.</span>
              ) : (
                allAgents
                  .filter((a) => a.skillIds.includes(skill?.id ?? ""))
                  .map((a) => (
                    <span key={a.id} className="text-xs" style={{ color: "var(--lx-text-secondary)" }}>{a.name}</span>
                  ))
              )}
            </div>
            <div className="field-hint">Read-only — bindings are managed from the agent editor.</div>
          </div>
        )}

        {/* Delivery preview — what the daemon writes into the run dir */}
        <div className="field">
          <span className="field-label">
            Delivery preview{" "}
            <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]" style={{ marginLeft: 6 }}>
              ~/.lexa/runs/&lt;taskId&gt;/{isAgent ? "AGENTS.md" : `.agents/${skill?.id ?? "<skill>"}/SKILL.md`}
            </span>
          </span>
          <div style={{ background: "var(--lx-surface-input)", border: "1px solid var(--lx-border-default)", borderRadius: 6, padding: "10px 12px", fontFamily: "var(--lx-font-mono)", fontSize: 11, lineHeight: 1.7, color: "var(--lx-text-secondary)", maxHeight: 140, overflowY: "auto", whiteSpace: "pre-wrap" }}>
            {isAgent ? (
              <>
                <span className="text-lx-text-muted"># AGENTS.md — {name || "unnamed"}</span>
                {"\n\n"}
                {instructions || "…"}
                {attachedNames.length > 0 && (
                  <>
                    {"\n\n"}
                    <span className="text-lx-text-muted"># .agents/&lt;skill&gt;/SKILL.md — attached skill{attachedNames.length > 1 ? "s" : ""} ({attachedNames.join(", ")})</span>
                    {"\n"}
                    <span className="text-lx-text-muted">the selected skill's instructions, written when the skill runs</span>
                  </>
                )}
              </>
            ) : (
              <>
                <span className="text-lx-text-muted"># .agents/{skill?.id ?? "<skill>"}/SKILL.md — {name || "unnamed"}</span>
                {"\n\n"}
                {instructions || "…"}
              </>
            )}
          </div>
          <div className="field-hint">Rendered view of what ships in the claim payload when this {kind} runs.</div>
        </div>

        <div className="flex items-center justify-between mt-5">
          <div className="flex items-center gap-2">
            {isBuiltin ? (
              <button type="button" className="btn btn-ghost" style={{ height: 28, padding: "0 10px", fontSize: 12 }} onClick={handleReset} disabled={resetAgent.isPending || resetSkill.isPending}>
                Reset to default
              </button>
            ) : (
              entity && (
                <button type="button" className="btn btn-danger" style={{ height: 28, padding: "0 10px", fontSize: 12 }} onClick={handleDelete} disabled={deleteAgent.isPending || deleteSkill.isPending}>
                  Delete
                </button>
              )
            )}
          </div>
          <div className="flex" style={{ gap: 8 }}>
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={handleSave} disabled={!canSave || pending}>
              {pending ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>
        {isBuiltin && (
          <span className="annotation-tag" style={{ display: "block", marginTop: 10 }}>
            Builtin {kind}: Reset to default restores the seeded {isAgent ? "instructions + full builtin skill set" : "instructions"}. Builtins can't be deleted.
          </span>
        )}
      </div>
    </div>
  );
}
