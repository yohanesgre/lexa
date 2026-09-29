import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import {
  useProjects,
  useAgents,
  useSkills,
  useAssistantSettings,
  useCreateAssistantTask,
  useCancelAssistantTask,
  useTaskAttachments,
  useWikiAttachments,
  useAssistantTask,
} from "./queries";
import { useAssistantStream, assistantGetSnapshot } from "./use-assistant-stream";
import type { Attachment } from "../../shared/types";
import {
  attachmentQueryId,
  pickAttachmentRows,
  pickAssistantSkill,
  toDocImages,
  buildRunRequest,
  resolveRunSelection,
  getSelection,
} from "../components/assistant/panel/assistant-panel-utils";
import {
  getAssistantPanelSession,
  patchAssistantPanelSession,
} from "../components/assistant/panel/assistant-panel-store";

// Assistant panel session logic (herald-popover.html). Split from the panel
// component: data/skill selection here, run lifecycle here, markup in the
// AssistantPanel* view files.

type PanelArgs = {
  editor: Editor;
  slug: string;
  documentType: "task" | "wiki";
  documentId: string;
};

function useAssistantPanelData({ editor, slug, documentType, documentId }: PanelArgs) {
  const { data: projects = [] } = useProjects();
  // null after load = PROVIDER_NOT_CONFIGURED → empty state + disabled Generate.
  const projectId = projects.find((p) => p.slug === slug)?.id;
  const { data: settings, isLoading: settingsLoading, isError: settingsError, refetch: refetchSettings } = useAssistantSettings(projectId);
  const { data: agents = [] } = useAgents();
  const { data: skills = [] } = useSkills();
  const [skillId, setSkillIdState] = useState(() => getAssistantPanelSession(slug, documentType, documentId).skillId);

  const setSkillId = useCallback(
    (id: string) => {
      setSkillIdState(id);
      patchAssistantPanelSession(slug, documentType, documentId, { skillId: id });
    },
    [slug, documentType, documentId]
  );

  // Images ride from the document, never manual attach: ids embedded in the
  // open doc mapped to attachment rows (taskId / wiki pageSlug per type).
  const { data: taskRows } = useTaskAttachments(slug, attachmentQueryId(documentType, "task", documentId));
  const { data: wikiRows } = useWikiAttachments(slug, attachmentQueryId(documentType, "wiki", documentId));
  // Embed add/remove is an editor update, not a prop change — bump an epoch so
  // the display list re-reads the doc even though `editor` is stable.
  const [docEpoch, setDocEpoch] = useState(0);
  useEffect(() => {
    const bump = () => setDocEpoch((e) => e + 1);
    editor.on("update", bump);
    return () => {
      editor.off("update", bump);
    };
  }, [editor]);
  const docImages = useMemo(
    () => toDocImages(pickAttachmentRows(documentType, taskRows, wikiRows), editor),
    [editor, documentType, taskRows, wikiRows, docEpoch]
  );

  const picked = pickAssistantSkill(agents, skills, skillId);

  return {
    projectId,
    settings,
    settingsLoading,
    settingsError,
    refetchSettings,
    agentSkills: picked.agentSkills,
    effectiveSkillId: picked.effectiveSkillId,
    skillName: picked.skillName,
    setSkillId,
    docImages,
    taskRows,
    wikiRows,
  };
}

type RunArgs = PanelArgs & {
  prompt: string;
  effectiveSkillId: string;
  taskRows: Attachment[] | undefined;
  wikiRows: Attachment[] | undefined;
};

function useAssistantRun(args: RunArgs) {
  const { editor, slug, documentType, documentId, prompt, effectiveSkillId, taskRows, wikiRows } = args;
  const createTask = useCreateAssistantTask();
  const cancelTask = useCancelAssistantTask();
  // Rehydrate the last run for this document: closing the popover keeps the
  // module stream session alive, so reopening lands on its live/final state.
  const [taskId, setTaskId] = useState<string | null>(() => getAssistantPanelSession(slug, documentType, documentId).taskId);

  // Enqueue → open the SSE stream exactly once per task id. `stream` is
  // recreated per render, so the ref guard (not dep equality) dedupes sends.
  const streamKey = taskId ? `assistant-task:${taskId}` : null;
  const stream = useAssistantStream(streamKey);
  const streamedTaskRef = useRef<string | null>(null);
  useEffect(() => {
    if (!taskId || !streamKey) return;
    if (streamedTaskRef.current === taskId) return;
    streamedTaskRef.current = taskId;
    // Only a task with no session yet gets a POST. A rehydrated terminal
    // (done/error) or live session is reattached, never re-streamed —
    // send() would otherwise start a fresh session and re-POST.
    if (assistantGetSnapshot(streamKey).status === "idle") {
      stream.send(`/api/assistant/tasks/${taskId}/stream`, {});
    }
  }, [taskId, streamKey, stream]);

  // Selection label updates on editor selection/doc changes; the run reads the
  // selection fresh at click time (never a stale render value).
  const [selectionText, setSelectionText] = useState(() => getSelection(editor).text);
  useEffect(() => {
    const update = () => setSelectionText(getSelection(editor).text);
    update();
    editor.on("selectionUpdate", update);
    editor.on("update", update);
    return () => {
      editor.off("selectionUpdate", update);
      editor.off("update", update);
    };
  }, [editor]);

  const running = stream.status === "connecting" || stream.status === "streaming";
  const done = stream.status === "done";
  const failed = stream.status === "error";
  const { data: assistantTaskData } = useAssistantTask(taskId, !!taskId && done);

  const generate = useCallback(() => {
    if (!effectiveSkillId) return;
    const selection = getSelection(editor);
    const selectionMarkdown = resolveRunSelection(editor, effectiveSkillId, selection);
    const images = toDocImages(pickAttachmentRows(documentType, taskRows, wikiRows), editor);
    createTask.mutate(
      buildRunRequest({ slug, documentType, documentId, prompt, skillId: effectiveSkillId, selection: selectionMarkdown, docImages: images }),
      {
        onSuccess: (task) => {
          setTaskId(task.id);
          patchAssistantPanelSession(slug, documentType, documentId, { taskId: task.id });
        },
      }
    );
  }, [editor, effectiveSkillId, createTask, slug, documentType, documentId, prompt, taskRows, wikiRows]);

  const stop = useCallback(() => {
    if (!taskId) return;
    stream.abort();
    cancelTask.mutate(taskId);
  }, [taskId, stream, cancelTask]);

  const dismiss = useCallback(() => {
    setTaskId(null);
    patchAssistantPanelSession(slug, documentType, documentId, { taskId: null });
  }, [slug, documentType, documentId]);

  return {
    stream,
    running,
    done,
    failed,
    taskId,
    documentTitle: assistantTaskData?.documentTitle,
    selectionText,
    generate,
    stop,
    dismiss,
    createPending: createTask.isPending,
  };
}

// RejectedTaskId needed by DoneView's alreadyHandled check flows through the
// panel props, not the session hook.
export function useAssistantPanel(args: PanelArgs) {
  const { slug, documentType, documentId } = args;
  // Draft + skill choice survive close/reopen per project + document.
  const [prompt, setPromptState] = useState(() => getAssistantPanelSession(slug, documentType, documentId).prompt);
  const setPrompt = useCallback(
    (value: string) => {
      setPromptState(value);
      patchAssistantPanelSession(slug, documentType, documentId, { prompt: value });
    },
    [slug, documentType, documentId]
  );
  const data = useAssistantPanelData(args);
  const run = useAssistantRun({
    ...args,
    prompt,
    effectiveSkillId: data.effectiveSkillId,
    taskRows: data.taskRows,
    wikiRows: data.wikiRows,
  });
  return { ...data, prompt, setPrompt, ...run };
}
