import type { Editor } from "@tiptap/core";
import { useHeraldPanel } from "../../../lib/use-herald-panel";
import { HeraldPanelHeader } from "./HeraldPanelHeader";
import { HeraldPanelBody } from "./HeraldPanelBody";
import { HeraldPanelIdle } from "./HeraldPanelIdle";
import type { HearthMode } from "./HeraldModePicker";
import type { ReviewIdentity } from "./HeraldDoneView";

// Herald tier panel inside the Hearth popover — transcribed from
// wireframes/src/herald-popover.html (States 1–7). No agent picker: the
// persona is the project's configured Herald Agent (Project Settings →
// Herald); only the skill is picked here. Streaming sessions live in the
// module-level stream store: closing the popover does NOT stop the run;
// reopening reattaches to the live/final state. Session logic lives in
// useHeraldPanel; markup in the HeraldPanel* view files.
export function HeraldPanel({ editor, slug, documentType, documentId, engineSwitcherEnabled, onModeChange, onClose, onReview, reviewActive, appliedTaskId, rejectedTaskId }: {
  editor: Editor;
  slug: string;
  documentType: "task" | "wiki";
  documentId: string;
  engineSwitcherEnabled: boolean;
  onModeChange: (mode: HearthMode) => void;
  onClose: () => void;
  onReview?: (text: string, identity: ReviewIdentity) => void;
  reviewActive?: boolean | undefined;
  appliedTaskId?: string | null | undefined;
  rejectedTaskId?: string | null | undefined;
}) {
  const panel = useHeraldPanel({ editor, slug, documentType, documentId });
  // null after load = PROVIDER_NOT_CONFIGURED → empty state + disabled Generate.
  const providerMissing = !panel.settingsLoading && panel.settings === null;

  return (
    <>
      <HeraldPanelHeader
        running={panel.running}
        done={panel.done}
        failed={panel.failed}
        engineSwitcherEnabled={engineSwitcherEnabled}
        onModeChange={onModeChange}
      />
      <HeraldPanelBody
        stream={panel.stream}
        settings={panel.settings}
        providerMissing={providerMissing}
        projectId={panel.projectId}
        documentTitle={panel.documentTitle}
        skillName={panel.skillName}
        provider={panel.settings?.model ?? panel.settings?.baseUrl ?? null}
        taskId={panel.taskId}
        appliedTaskId={appliedTaskId}
        rejectedTaskId={rejectedTaskId}
        reviewActive={reviewActive}
        onReview={onReview}
        onRetry={panel.generate}
        onStop={panel.stop}
        onDismiss={panel.dismiss}
        editor={editor}
        onClose={onClose}
      >
        <HeraldPanelIdle
          agentSkills={panel.agentSkills}
          skillId={panel.effectiveSkillId}
          onSkillChange={panel.setSkillId}
          prompt={panel.prompt}
          onPromptChange={panel.setPrompt}
          docImages={panel.docImages}
          selectionText={panel.selectionText}
          settings={panel.settings}
          createPending={panel.createPending}
          onGenerate={panel.generate}
        />
      </HeraldPanelBody>
    </>
  );
}
