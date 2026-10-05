import type { Editor } from "@tiptap/core";
import { useAssistantPanel } from "../../../lib/use-assistant-panel";
import { AssistantPanelHeader } from "./AssistantPanelHeader";
import { AssistantPanelBody } from "./AssistantPanelBody";
import { AssistantPanelIdle } from "./AssistantPanelIdle";
import type { AssistantReviewIdentity } from "../../../lib/useAssistantReview";

// Assistant tier panel inside the Runtime popover — transcribed from
// wireframes/src/herald-popover.html (States 1–7). No agent or skill picker:
// the persona is the project's configured Assistant Agent (Project Settings →
// Assistant) and the assistant picks suitable skill(s) itself (auto skill
// selection). Streaming sessions live in the module-level stream store:
// closing the popover does NOT stop the run; reopening reattaches to the
// live/final state. Session logic lives in useAssistantPanel; markup in the
// AssistantPanel* view files.
export function AssistantPanel({ editor, slug, documentType, documentId, onClose, onReview, reviewActive, appliedTaskId, rejectedTaskId }: {
  editor: Editor;
  slug: string;
  documentType: "task" | "wiki";
  documentId: string;
  onClose: () => void;
  onReview?: (text: string, identity: AssistantReviewIdentity) => void;
  reviewActive?: boolean | undefined;
  appliedTaskId?: string | null | undefined;
  rejectedTaskId?: string | null | undefined;
}) {
  const panel = useAssistantPanel({ editor, slug, documentType, documentId });
  // null after load = PROVIDER_NOT_CONFIGURED → empty state + disabled Generate.
  const providerMissing = !panel.settingsLoading && panel.settings === null;

  return (
    <>
      <AssistantPanelHeader
        running={panel.running}
        done={panel.done}
        failed={panel.failed}
      />
      <AssistantPanelBody
        stream={panel.stream}
        providerMissing={providerMissing}
        settingsError={panel.settingsError}
        onRetrySettings={panel.refetchSettings}
        projectId={panel.projectId}
        documentTitle={panel.documentTitle}
        skillName={panel.skillName}
        providerLabel={panel.settings?.model ?? panel.settings?.baseUrl ?? null}
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
        reconnecting={panel.stream.reconnecting}
      >
        <AssistantPanelIdle
          prompt={panel.prompt}
          onPromptChange={panel.setPrompt}
          docImages={panel.docImages}
          selectionText={panel.selectionText}
          settings={panel.settings}
          createPending={panel.createPending}
          onGenerate={panel.generate}
        />
      </AssistantPanelBody>
    </>
  );
}
