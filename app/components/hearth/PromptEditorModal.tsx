import { useState } from "react";
import { X } from "lucide-react";
import { useCreateHearthAgent, useCreateHearthSkill, useDeleteHearthAgent, useDeleteHearthSkill, useReplaceAgentSkills, useResetHearthAgent, useResetHearthSkill, useUpdateHearthAgent, useUpdateHearthSkill } from "../../lib/queries";
import type { LexaAgent, LexaSkill } from "../../../shared/types";

interface PromptEditorModalProps {
  kind: "agent" | "skill";
  entity: LexaAgent | LexaSkill | null;
  allSkills?: LexaSkill[];
  allAgents?: LexaAgent[];
  onClose: () => void;
}

type PromptEntity = LexaAgent | LexaSkill;

function initialPromptForm(entity: PromptEntity | null, isAgent: boolean) {
  if (entity === null) return { name: "", description: "", instructions: "", attachedSkillIds: [] as string[] };
  return {
    name: entity.name,
    description: entity.description,
    instructions: entity.instructions,
    attachedSkillIds: isAgent && "skillIds" in entity ? entity.skillIds : ([] as string[]),
  };
}

function promptDirty(entity: PromptEntity | null, name: string, description: string, instructions: string): boolean {
  if (entity === null) return true;
  return name !== entity.name || description !== entity.description || instructions !== entity.instructions;
}

function skillsListChanged(agent: LexaAgent | null, attachedSkillIds: string[]): boolean {
  if (agent === null) return false;
  return JSON.stringify([...attachedSkillIds].toSorted()) !== JSON.stringify([...agent.skillIds].toSorted());
}

function canSavePrompt(name: string, instructions: string, dirty: boolean, skillsDirty: boolean): boolean {
  return name.trim().length > 0 && instructions.trim().length > 0 && (dirty || skillsDirty);
}

function builtinFlag(isAgent: boolean, agent: LexaAgent | null, skill: LexaSkill | null): boolean {
  return (isAgent ? agent?.isBuiltin : skill?.isBuiltin) ?? false;
}

function persistPromptEntity(args: {
  isAgent: boolean;
  isNew: boolean;
  agent: LexaAgent | null;
  skill: LexaSkill | null;
  name: string;
  description: string;
  instructions: string;
  attachedSkillIds: string[];
  skillsDirty: boolean;
  createAgent: ReturnType<typeof useCreateHearthAgent>;
  updateAgent: ReturnType<typeof useUpdateHearthAgent>;
  replaceSkills: ReturnType<typeof useReplaceAgentSkills>;
  createSkill: ReturnType<typeof useCreateHearthSkill>;
  updateSkill: ReturnType<typeof useUpdateHearthSkill>;
  onClose: () => void;
}): void {
  const values = { name: args.name.trim(), description: args.description.trim(), instructions: args.instructions };
  if (args.isAgent) {
    if (args.isNew) {
      args.createAgent.mutate(values, {
        onSuccess: (created) => {
          if (args.attachedSkillIds.length > 0) args.replaceSkills.mutate({ id: created.id, skillIds: args.attachedSkillIds });
          args.onClose();
        },
      });
      return;
    }
    if (args.agent) {
      const target = args.agent;
      args.updateAgent.mutate({ id: target.id, patch: values }, {
        onSuccess: () => {
          if (args.skillsDirty) args.replaceSkills.mutate({ id: target.id, skillIds: args.attachedSkillIds });
          args.onClose();
        },
      });
    }
    return;
  }
  if (args.isNew) {
    args.createSkill.mutate(values, { onSuccess: args.onClose });
    return;
  }
  if (args.skill) {
    args.updateSkill.mutate({ id: args.skill.id, patch: values }, { onSuccess: args.onClose });
  }
}

function SkillsAttachField({ allSkills, attachedSkillIds, setAttachedSkillIds }: {
  allSkills: LexaSkill[];
  attachedSkillIds: string[];
  setAttachedSkillIds: (updater: (prev: string[]) => string[]) => void;
}) {
  const attachedSet = new Set(attachedSkillIds);
  const onToggle = (id: string, checked: boolean) =>
    setAttachedSkillIds((prev) => (checked ? [...prev, id] : prev.filter((existing) => existing !== id)));
  return (
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
                onChange={(e) => onToggle(s.id, e.target.checked)}
              />
              {s.name} <span className="text-xs text-lx-text-muted">— {s.description || "no description"}</span>
            </label>
          ))
        )}
      </div>
      <div className="field-hint">The Hearth popover only offers skills attached here. An agent with none can't generate.</div>
    </div>
  );
}

function UsedByField({ allAgents, skillId }: { allAgents: LexaAgent[]; skillId: string }) {
  const usingAgents = allAgents.filter((a) => a.skillIds.includes(skillId));
  return (
    <div className="field">
      <span className="field-label">Used by</span>
      <div style={{ background: "var(--lx-surface-input)", border: "1px solid var(--lx-border-default)", borderRadius: 6, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
        {usingAgents.length === 0 ? (
          <span className="text-xs text-lx-text-muted">No agents use this skill yet.</span>
        ) : (
          usingAgents.map((a) => (
            <span key={a.id} className="text-xs" style={{ color: "var(--lx-text-secondary)" }}>{a.name}</span>
          ))
        )}
      </div>
      <div className="field-hint">Read-only — bindings are managed from the agent editor.</div>
    </div>
  );
}

function DeliveryPreview({ isAgent, kind, name, instructions, skillId, allSkills, attachedSkillIds }: {
  isAgent: boolean;
  kind: string;
  name: string;
  instructions: string;
  skillId: string;
  allSkills: LexaSkill[];
  attachedSkillIds: string[];
}) {
  const attachedSet = new Set(attachedSkillIds);
  const attachedNames = allSkills.flatMap((s) => (attachedSet.has(s.id) ? [s.name] : []));
  return (
    <div className="field">
      <span className="field-label">
        Delivery preview{" "}
        <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]" style={{ marginLeft: 6 }}>
          ~/.lexa/runs/&lt;taskId&gt;/{isAgent ? "AGENTS.md" : `.agents/${skillId}/SKILL.md`}
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
            <span className="text-lx-text-muted"># .agents/{skillId}/SKILL.md — {name || "unnamed"}</span>
            {"\n\n"}
            {instructions || "…"}
          </>
        )}
      </div>
      <div className="field-hint">Rendered view of what ships in the claim payload when this {kind} runs.</div>
    </div>
  );
}

function EditorExtras({ isAgent, kind, name, instructions, allSkills, allAgents, skillId, attachedSkillIds, setAttachedSkillIds, isBuiltin }: {
  isAgent: boolean;
  kind: string;
  name: string;
  instructions: string;
  allSkills: LexaSkill[];
  allAgents: LexaAgent[];
  skillId: string;
  attachedSkillIds: string[];
  setAttachedSkillIds: (updater: (prev: string[]) => string[]) => void;
  isBuiltin: boolean;
}) {
  return (
    <>
      {isAgent && <SkillsAttachField allSkills={allSkills} attachedSkillIds={attachedSkillIds} setAttachedSkillIds={setAttachedSkillIds} />}
      {!isAgent && allAgents.length > 0 && <UsedByField allAgents={allAgents} skillId={skillId} />}
      <DeliveryPreview
        isAgent={isAgent}
        kind={kind}
        name={name}
        instructions={instructions}
        skillId={skillId}
        allSkills={allSkills}
        attachedSkillIds={attachedSkillIds}
      />
      {isBuiltin && (
        <span className="annotation-tag" style={{ display: "block", marginTop: 10 }}>
          Builtin {kind}: Reset to default restores the seeded {isAgent ? "instructions + full builtin skill set" : "instructions"}. Builtins can't be deleted.
        </span>
      )}
    </>
  );
}

function EditorFooter({ isBuiltin, entity, canSave, pending, resetPending, deletePending, onClose, onSave, onDelete, onReset }: {
  isBuiltin: boolean;
  entity: PromptEntity | null;
  canSave: boolean;
  pending: boolean;
  resetPending: boolean;
  deletePending: boolean;
  onClose: () => void;
  onSave: () => void;
  onDelete: () => void;
  onReset: () => void;
}) {
  return (
    <div className="flex items-center justify-between mt-5">
      <div className="flex items-center gap-2">
        {isBuiltin ? (
          <button type="button" className="btn btn-ghost" style={{ height: 28, padding: "0 10px", fontSize: 12 }} onClick={onReset} disabled={resetPending}>
            Reset to default
          </button>
        ) : (
          entity && (
            <button type="button" className="btn btn-danger" style={{ height: 28, padding: "0 10px", fontSize: 12 }} onClick={onDelete} disabled={deletePending}>
              Delete
            </button>
          )
        )}
      </div>
      <div className="flex" style={{ gap: 8 }}>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={onSave} disabled={!canSave || pending}>
          {pending ? "Saving…" : "Save changes"}
        </button>
      </div>
    </div>
  );
}

// Settings editor for Hearth agents + skills (global rule bundles). The
// instructions become files in the run dir at claim time (AGENTS.md /
// .agents/<skill>/SKILL.md) — the preview shows exactly what ships.
export function PromptEditorModal({ kind, entity, allSkills = [], allAgents = [], onClose }: PromptEditorModalProps) {
  const isNew = entity === null;
  const isAgent = kind === "agent";
  const agent = isAgent ? (entity as LexaAgent | null) : null;
  const skill = !isAgent ? (entity as LexaSkill | null) : null;
  const isBuiltin = builtinFlag(isAgent, agent, skill);

  const initial = initialPromptForm(entity, isAgent);
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [instructions, setInstructions] = useState(initial.instructions);
  const [attachedSkillIds, setAttachedSkillIds] = useState<string[]>(initial.attachedSkillIds);

  const createAgent = useCreateHearthAgent();
  const updateAgent = useUpdateHearthAgent();
  const deleteAgent = useDeleteHearthAgent();
  const replaceSkills = useReplaceAgentSkills();
  const resetAgent = useResetHearthAgent();
  const createSkill = useCreateHearthSkill();
  const updateSkill = useUpdateHearthSkill();
  const deleteSkill = useDeleteHearthSkill();
  const resetSkill = useResetHearthSkill();

  const dirty = promptDirty(entity, name, description, instructions);
  const skillsDirty = skillsListChanged(agent, attachedSkillIds);
  const canSave = canSavePrompt(name, instructions, dirty, skillsDirty);
  const pending = [createAgent, updateAgent, replaceSkills, createSkill, updateSkill].some((m) => m.isPending);
  const resetPending = [resetAgent, resetSkill].some((m) => m.isPending);
  const deletePending = [deleteAgent, deleteSkill].some((m) => m.isPending);

  const handleSave = () => {
    if (!canSave) return;
    persistPromptEntity({
      isAgent, isNew, agent, skill, name, description, instructions, attachedSkillIds, skillsDirty,
      createAgent, updateAgent, replaceSkills, createSkill, updateSkill, onClose,
    });
  };

  const handleDelete = () => {
    if (!entity) return;
    if (!window.confirm(`Delete ${kind} '${entity.name}'? This cannot be undone.`)) return;
    (isAgent ? deleteAgent : deleteSkill).mutate(entity.id, { onSuccess: onClose });
  };

  const handleReset = () => {
    if (!entity) return;
    (isAgent ? resetAgent : resetSkill).mutate(entity.id, { onSuccess: onClose });
  };

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

        <EditorExtras
          isAgent={isAgent}
          kind={kind}
          name={name}
          instructions={instructions}
          allSkills={allSkills}
          allAgents={allAgents}
          skillId={skill?.id ?? ""}
          attachedSkillIds={attachedSkillIds}
          setAttachedSkillIds={setAttachedSkillIds}
          isBuiltin={isBuiltin}
        />

        <EditorFooter
          isBuiltin={isBuiltin}
          entity={entity}
          canSave={canSave}
          pending={pending}
          resetPending={resetPending}
          deletePending={deletePending}
          onClose={onClose}
          onSave={handleSave}
          onDelete={handleDelete}
          onReset={handleReset}
        />
      </div>
    </div>
  );
}
