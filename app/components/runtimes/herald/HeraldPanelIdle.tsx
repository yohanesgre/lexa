import type { Attachment, LexaSkill } from "../../../../shared/types";
import type { HeraldSettingsMasked } from "../../../../shared/herald";
import { SkillPicker } from "./SkillPicker";
import { HeraldFlameIcon } from "./HeraldFlameIcon";

// Idle phase (herald-popover.html States 1–2): skill pick, additional
// prompt, document images, selection line, Generate.
export function HeraldPanelIdle({
  agentSkills,
  skillId,
  onSkillChange,
  prompt,
  onPromptChange,
  docImages,
  selectionText,
  settings,
  createPending,
  onGenerate,
}: {
  agentSkills: LexaSkill[];
  skillId: string;
  onSkillChange: (id: string) => void;
  prompt: string;
  onPromptChange: (value: string) => void;
  docImages: Attachment[];
  selectionText: string;
  settings: HeraldSettingsMasked | null | undefined;
  createPending: boolean;
  onGenerate: () => void;
}) {
  return (
    <>
      <SkillPicker skills={agentSkills} skillId={skillId} onSkillChange={onSkillChange} />          <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--lx-border-default)" }}>
        <span className="prop-label" style={{ display: "block", marginBottom: 6 }}>
          Additional prompt <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]" style={{ marginLeft: 4 }}>Optional</span>
        </span>
        <textarea
          className="prop-input w-full"
          rows={3}
          aria-label="Additional prompt"
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          placeholder="What should Herald write?"
          style={{ fontSize: 12, lineHeight: 1.5, resize: "vertical" }}
        />
        {docImages.length > 0 ? (
          <div className="flex items-center gap-2" style={{ marginTop: 8 }}>
            {docImages.map((a) => (
              <div
                key={a.id}
                title={a.filename}
                style={{
                  width: 28,
                  height: 28,
                  border: "1px solid var(--lx-border-default)",
                  borderRadius: 4,
                  background: "var(--lx-surface-card-hover)",
                  overflow: "hidden",
                  flexShrink: 0,
                }}
              >
                <img src={`/api/attachments/${a.id}`} alt={a.filename} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
              </div>
            ))}
            <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">
              From document · {docImages.length} image{docImages.length === 1 ? "" : "s"}
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-2" style={{ marginTop: 8 }}>
            <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">No images in document</span>
          </div>
        )}
      </div>
      <div style={{ padding: "10px 12px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">
          {selectionText ? `Selection: ${selectionText.length} chars` : "No selection"}
        </span>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={onGenerate}
          disabled={createPending || !settings || !skillId}
        >
          <HeraldFlameIcon size={12} />
          {createPending ? "Starting…" : "Generate"}
        </button>
      </div>
    </>
  );
}
