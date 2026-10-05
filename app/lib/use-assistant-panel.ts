import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import {
  useProjects,
  useAssistantSettings,
  useCreateAssistantTask,
  useCancelAssistantTask,
  useTaskAttachments,
  useWikiAttachments,
  useAssistantTask,
} from "./queries";
import { useAssistantAgent, type AssistantAgentStream } from "./use-assistant-agent";
import type { Attachment } from "../../shared/types";
import {
  attachmentQueryId,
  pickAttachmentRows,
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
// component: document data here, run lifecycle here, markup in the
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

  return {
    projectId,
    settings,
    settingsLoading,
    settingsError,
    refetchSettings,
    docImages,
    taskRows,
    wikiRows,
  };
}

type RunArgs = PanelArgs & {
  prompt: string;
  taskRows: Attachment[] | undefined;
  wikiRows: Attachment[] | undefined;
};

function useAssistantRun(args: RunArgs) {
  const { editor, slug, documentType, documentId, prompt, taskRows, wikiRows } = args;
  const createTask = useCreateAssistantTask();
  const cancelTask = useCancelAssistantTask();
  // Rehydrate the last run for this document: closing the popover keeps the
  // module stream session alive, so reopening lands on its live/final state.
  const [taskId, setTaskId] = useState<string | null>(() => getAssistantPanelSession(slug, documentType, documentId).taskId);

  // Enqueue → attach to the run's WebSocket thread (`task:<id>`). The server
  // enqueued the turn via `enqueueRun` when POST /api/assistant/tasks landed;
  // the client never POSTs to start it, and a dropped socket does not cancel
  // it (ADR-0003 D5, background-capable). The WS replays an IN-FLIGHT turn on
  // connect; anything already finished is reconstructed from the task row.
  const streamKey = taskId ? `assistant-task:${taskId}` : null;
  const live = useAssistantAgent(streamKey);
  const { data: assistantTaskData } = useAssistantTask(taskId, !!taskId);

  // A background run that completed (or is still queued/running) while this
  // client was disconnected has no in-flight WS buffer to replay, so the
  // popover would sit on Idle. The task row is the authority for those
  // terminal/pending states (herald-popover.html "background run finished
  // while disconnected lands on Done on reconnect"). A live WS turn always wins.
  const stream = useMemo<AssistantAgentStream>(() => {
    if (live.status !== "idle" || !assistantTaskData) return live;
    switch (assistantTaskData.status) {
      case "completed":
        return { ...live, status: "done", text: live.text || (assistantTaskData.result ?? ""), hasIngress: true };
      case "failed":
        return {
          ...live,
          status: "error",
          error: { code: "ASSISTANT_GENERATION_FAILED", message: assistantTaskData.error ?? "Assistant generation failed" },
        };
      case "queued":
      case "running":
        return { ...live, status: "connecting" };
      default:
        return live;
    }
  }, [live, assistantTaskData]);

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

  const generate = useCallback(() => {
    const selection = getSelection(editor);
    const selectionMarkdown = resolveRunSelection(selection);
    const images = toDocImages(pickAttachmentRows(documentType, taskRows, wikiRows), editor);
    createTask.mutate(
      buildRunRequest({ slug, documentType, documentId, prompt, selection: selectionMarkdown, docImages: images }),
      {
        onSuccess: (task) => {
          setTaskId(task.id);
          patchAssistantPanelSession(slug, documentType, documentId, { taskId: task.id });
        },
      }
    );
  }, [editor, createTask, slug, documentType, documentId, prompt, taskRows, wikiRows]);

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
    // Review identity (not the Done card — it shows the document title only):
    // the server resolves the skill in auto mode, so the task row is the
    // authority for the name.
    skillName: assistantTaskData?.skillName ?? "",
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
  // Draft survives close/reopen per project + document.
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
    taskRows: data.taskRows,
    wikiRows: data.wikiRows,
  });
  return { ...data, prompt, setPrompt, ...run };
}
