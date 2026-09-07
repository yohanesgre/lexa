import { useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import {
  useProjects,
  useAgents,
  useSkills,
  useHeraldSettings,
  useCreateHeraldTask,
  useCancelHeraldTask,
  useTaskAttachments,
  useWikiAttachments,
  useHearthTask,
} from "./queries";
import { useHeraldStream } from "./use-herald-stream";
import {
  attachmentQueryId,
  pickAttachmentRows,
  pickHeraldSkill,
  toDocImages,
  buildRunRequest,
  resolveRunSelection,
  getSelection,
} from "../components/hearth/herald/herald-panel-utils";

// Herald panel session logic (herald-popover.html). Split from the panel
// component: data/skill selection here, run lifecycle here, markup in the
// HeraldPanel* view files.

type PanelArgs = {
  editor: Editor;
  slug: string;
  documentType: "task" | "wiki";
  documentId: string;
};

function useHeraldPanelData({ editor, slug, documentType, documentId }: PanelArgs) {
  const { data: projects = [] } = useProjects();
  // null after load = PROVIDER_NOT_CONFIGURED → empty state + disabled Generate.
  const projectId = projects.find((p) => p.slug === slug)?.id;
  const { data: settings, isLoading: settingsLoading } = useHeraldSettings(projectId);
  const { data: agents = [] } = useAgents();
  const { data: skills = [] } = useSkills();
  const [skillId, setSkillId] = useState("");

  // Images ride from the document, never manual attach: ids embedded in the
  // open doc mapped to attachment rows (taskId / wiki pageSlug per type).
  const { data: taskRows } = useTaskAttachments(slug, attachmentQueryId(documentType, "task", documentId));
  const { data: wikiRows } = useWikiAttachments(slug, attachmentQueryId(documentType, "wiki", documentId));
  const docImages = useMemo(
    () => toDocImages(pickAttachmentRows(documentType, taskRows, wikiRows), editor),
    [editor, documentType, taskRows, wikiRows]
  );

  const picked = pickHeraldSkill(agents, skills, skillId);

  return { projectId, settings, settingsLoading, agentSkills: picked.agentSkills, effectiveSkillId: picked.effectiveSkillId, skillName: picked.skillName, setSkillId, docImages };
}

function useHeraldRun(args: PanelArgs & { prompt: string; effectiveSkillId: string; docImages: ReturnType<typeof toDocImages> }) {
  const { editor, slug, documentType, documentId, prompt, effectiveSkillId, docImages } = args;
  const createTask = useCreateHeraldTask();
  const cancelTask = useCancelHeraldTask();
  const [taskId, setTaskId] = useState<string | null>(null);

  // Enqueue → open the SSE stream exactly once per task id. `stream` is
  // recreated per render, so the ref guard (not dep equality) dedupes sends.
  const streamKey = taskId ? `herald-task:${taskId}` : null;
  const stream = useHeraldStream(streamKey);
  const streamedTaskRef = useRef<string | null>(null);
  useEffect(() => {
    if (taskId && streamedTaskRef.current !== taskId) {
      streamedTaskRef.current = taskId;
      stream.send(`/api/herald/tasks/${taskId}/stream`, {});
    }
  }, [taskId, stream]);

  const running = stream.status === "connecting" || stream.status === "streaming";
  const done = stream.status === "done";
  const failed = stream.status === "error";
  const { data: heraldTaskData } = useHearthTask(taskId, !!taskId && done);

  const selection = getSelection(editor);

  const generate = () => {
    if (!effectiveSkillId) return;
    const selectionMarkdown = resolveRunSelection(editor, effectiveSkillId, selection);
    createTask.mutate(
      buildRunRequest({ slug, documentType, documentId, prompt, skillId: effectiveSkillId, selection: selectionMarkdown, docImages }),
      { onSuccess: (task) => setTaskId(task.id) }
    );
  };

  const stop = () => {
    if (!taskId) return;
    stream.abort();
    cancelTask.mutate(taskId);
  };

  const dismiss = () => setTaskId(null);

  return { stream, running, done, failed, taskId, documentTitle: heraldTaskData?.documentTitle, selectionText: selection.text, generate, stop, dismiss, createPending: createTask.isPending };
}

// RejectedTaskId needed by DoneView's alreadyHandled check flows through the
// panel props, not the session hook.
export function useHeraldPanel(args: PanelArgs) {
  const [prompt, setPrompt] = useState("");
  const data = useHeraldPanelData(args);
  const run = useHeraldRun({
    ...args,
    prompt,
    effectiveSkillId: data.effectiveSkillId,
    docImages: data.docImages,
  });
  return { ...data, prompt, setPrompt, ...run };
}
