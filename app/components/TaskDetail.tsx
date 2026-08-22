import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { Check, ChevronDown, X } from "lucide-react";
import type { Task, TipTapDoc, GithubIssue } from "../../shared/types";
import { extractText } from "../../shared/tiptap-text";
import { renderDoc } from "./tiptap-render";
import { GithubMark, TrashIcon, ArchiveIcon, LinkIcon } from "./icons";
import { TextEditor } from "./TextEditor";
import { SelectDropdown } from "./ui/SelectDropdown";
import { AssigneeChips } from "./AssigneeChips";
import { DescriptionEditor } from "./DescriptionEditor";
import { SlideoverHeader } from "./SlideoverHeader";
import { TaskTitleInput } from "./TaskTitleInput";
import { TaskNotFoundDialog } from "./TaskNotFoundDialog";
import { useTaskDetailActions } from "./useTaskDetailActions";
import { TaskDescriptionSection } from "./TaskDescriptionSection";
import { DeleteTaskDialog } from "./DeleteTaskDialog";
import { MissingFieldsWarning } from "./MissingFieldsWarning";
import { TaskPropertyBar } from "./TaskPropertyBar";
import { GitHubSection } from "./GitHubSection";
import { AttachmentsPanel } from "./AttachmentsPanel";
import { TaskFooter } from "./TaskFooter";
import { Toolbar } from "./TextEditor";
import { textEditorExtensions } from "../lib/tiptap";
import { SourcesSection } from "./forge/SourcesSection";
import { LinksSection } from "./forge/LinksSection";
import { ForgeReviewSurface } from "./forge/ForgeReviewSurface";
import { useForgeReview } from "./forge/useForgeReview";
import { ActivityTab } from "./activity/ActivityTab";
import { cn } from "./ui/cn";
import { useEditor, EditorContent } from "@tiptap/react";
import type { JSONContent } from "@tiptap/core";





type RequiredFieldName = "assignee" | "description";

interface TaskDetailProps {
  mode?: "view" | "create";
  task?: Task;
  project?: { name: string };
  defaultColumnId?: string;
  columns?: { id: string; name: string; githubState?: "open" | "closed" | null }[];
  swimlanes?: { id: string; name: string }[];
  columnRequiredFields?: { columnId: string; fields: string[] }[];
  availableAssignees?: string[];
  taskTitles?: Map<string, string>;    // taskId → title, for link display
  taskKeys?: Map<string, string>;      // taskId → key, for link display
  fieldConfig?: { priorities: { id: string; label: string; color: string }[]; types: { id: string; label: string; color: string }[] };
  onClose: () => void;
  onUpdate?: (id: string, data: Partial<Task>) => void;
  onMove?: (id: string, target: { columnId: string; swimlaneId: string; beforeTaskId?: string; afterTaskId?: string }) => void;
  onDelete?: (id: string) => Promise<void>;
  onArchive?: (id: string) => Promise<void>;
  onRestore?: (id: string) => Promise<void>;
  onLinkGithub?: (id: string, repo: string) => Promise<{ repo: string; issueNumber: number } | null | undefined>;
  onUnlinkGithub?: (id: string, issueId: string) => Promise<void>;
  onCreate?: (input: {
    title: string;
    columnId: string;
    priority: string;
    type: string;
    assignees: string[];
    description: TipTapDoc;
    dueAt?: string | null;
  }) => Promise<void>;
}



const emptyDoc: TipTapDoc = { type: "doc", content: [] };

function getMissingRequiredFields(
  columnId: string,
  requiredFieldsMap: { columnId: string; fields: string[] }[] | undefined,
  values: { assignees: string[]; description: TipTapDoc }
): RequiredFieldName[] {
  const required = requiredFieldsMap?.find((column) => column.columnId === columnId)?.fields ?? [];
  const missing: RequiredFieldName[] = [];
  for (const field of required) {
    if (field === "assignee" && values.assignees.length === 0) {
      missing.push("assignee");
    } else if (field === "description" && extractText(values.description) === "") {
      missing.push("description");
    }
  }
  return missing;
}


export function TaskDetail({ mode = "view", task, project, defaultColumnId, columns, swimlanes, columnRequiredFields, availableAssignees, taskTitles, taskKeys, fieldConfig, onClose, onUpdate, onMove, onDelete, onArchive, onRestore, onLinkGithub, onUnlinkGithub, onCreate }: TaskDetailProps) {
  const params = useParams({ strict: false }) as { slug?: string };
  const slug = params.slug;
  const isCreate = mode === "create";

  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [dismissedWarning, setDismissedWarning] = useState(false);
  const [tab, setTab] = useState<"description" | "activity">("description");
  const closeTimer = useRef<number | null>(null);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(
    () => () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    },
    []
  );

  const handleClose = () => {
    setOpen(false);
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(onClose, 200);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showDeleteDialog) {
          e.stopPropagation();
          setShowDeleteDialog(false);
        } else {
          handleClose();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const {
    selectedColumnId, setSelectedColumnId,
    selectedSwimlaneId, setSelectedSwimlaneId,
    createTitle, setCreateTitle,
    createColumnId, setCreateColumnId,
    createPriority, setCreatePriority,
    createType, setCreateType,
    createAssignees, setCreateAssignees,
    createDescription, setCreateDescription,
    createDueAt, setCreateDueAt,
    creating,
    handleCreate,
  } = useTaskDetailActions({
    task,
    defaultColumnId,
    columns,
    fieldConfig,
    emptyDoc,
    onLinkGithub,
    onUnlinkGithub,
    onCreate,
    onClose: handleClose,
  });


  const [editingTitle, setEditingTitle] = useState(false);
  const [editingDescription, setEditingDescription] = useState(false);
  const [editingAssignees, setEditingAssignees] = useState(false);
  const [draft, setDraft] = useState(task?.title ?? "");

  const [prevTitle, setPrevTitle] = useState(task?.title);
  if (prevTitle !== task?.title && task?.title !== undefined) {
    setPrevTitle(task?.title);
    setDraft(task.title);
  }


  const saveTitle = () => {
    const v = draft.trim();
    if (v && v !== task?.title) onUpdate?.(task!.id, { title: v });
    setEditingTitle(false);
  };

  const handleConfirmDelete = async () => {
    if (!task || !onDelete) return;
    setDeleting(true);
    try {
      await onDelete(task.id);
    } finally {
      setDeleting(false);
    }
  };

  const currentColumnId = isCreate ? createColumnId : (selectedColumnId || task?.columnId || "");
  const currentColumnName = columns?.find((column) => column.id === currentColumnId)?.name ?? "";
  const currentSwimlaneName = swimlanes?.find((lane) => lane.id === selectedSwimlaneId)?.name ?? "";
  const isArchived = !isCreate && task != null && task.archivedAt != null;
  const missingFields = isCreate
    ? getMissingRequiredFields(createColumnId, columnRequiredFields, {
        assignees: createAssignees,
        description: createDescription,
      })
    : getMissingRequiredFields(currentColumnId, columnRequiredFields, {
        assignees: task?.assignees ?? [],
        description: task?.description ?? emptyDoc,
      });

  const missingFieldsKey = missingFields.join(",");

  const [prevFieldKey, setPrevFieldKey] = useState(`${currentColumnId}:${missingFieldsKey}`);
  if (prevFieldKey !== `${currentColumnId}:${missingFieldsKey}`) {
    setPrevFieldKey(`${currentColumnId}:${missingFieldsKey}`);
    setDismissedWarning(false);
  }

  if (!isCreate && !task) {
    return <TaskNotFoundDialog open={open} onClose={handleClose} />;
  }


  const githubs: GithubIssue[] = isCreate ? [] : task?.githubs ?? [];

  return (
    <>
      <button type="button" className={cn("slideover-overlay", !open && "overlay-closed")} onClick={handleClose} aria-label="Close" />
      <dialog open className={cn("slideover", expanded && "slideover-expanded", !open && "slideover-closed")} aria-modal="true" aria-label="Task details">
        <SlideoverHeader
          slug={slug}
          project={project ?? null}
          isCreate={isCreate}
          expanded={expanded}
          setExpanded={setExpanded}
          onClose={handleClose}
        />



        <div className="px-4 pt-4">
          {isArchived && (
            <div
              className="card-row flex items-center gap-2"
              style={{ background: "var(--lx-surface-elevated)", marginBottom: 12 }}
            >
              <ArchiveIcon size={14} />
              <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">
                Archived — not shown on the board unless "Show archived" is on
              </span>
            </div>
          )}
        <TaskTitleInput
          isArchived={isArchived}
          isCreate={isCreate}
          createTitle={createTitle}
          setCreateTitle={setCreateTitle}
          onCreate={handleCreate}
          onClose={handleClose}
          editingTitle={editingTitle}
          draft={draft}
          setDraft={setDraft}
          onSaveTitle={saveTitle}
          setEditingTitle={setEditingTitle}
          taskTitle={task?.title ?? ""}
          taskKey={task?.key ?? ""}
        />


        </div>

        <TaskPropertyBar
          isCreate={isCreate}
          task={task ?? null}
          columns={columns}
          swimlanes={swimlanes}
          fieldConfig={fieldConfig}
          missingFields={missingFields}
          currentColumnName={currentColumnName}
          currentSwimlaneName={currentSwimlaneName}
          selectedColumnId={selectedColumnId}
          setSelectedColumnId={setSelectedColumnId}
          selectedSwimlaneId={selectedSwimlaneId}
          setSelectedSwimlaneId={setSelectedSwimlaneId}
          onUpdate={onUpdate!}
          onMove={onMove!}
          createColumnId={createColumnId}
          setCreateColumnId={setCreateColumnId}
          createPriority={createPriority}
          setCreatePriority={setCreatePriority}
          createType={createType}
          setCreateType={setCreateType}
          createAssignees={createAssignees}
          setCreateAssignees={setCreateAssignees}
          createDueAt={createDueAt}
          setCreateDueAt={setCreateDueAt}
          availableAssignees={availableAssignees}
          editingAssignees={editingAssignees}
          setEditingAssignees={setEditingAssignees}
        />



        {missingFields.length > 0 && !dismissedWarning && (
          <MissingFieldsWarning
            columnName={currentColumnName}
            fields={missingFields}
            onDismiss={() => setDismissedWarning(true)}
          />
        )}

        {!isCreate && (
          <div className="tab-bar">
            <button type="button" className={cn("tab-btn", tab === "description" && "active")} onClick={() => setTab("description")}>
              Description
            </button>
            <button type="button" className={cn("tab-btn", tab === "activity" && "active")} onClick={() => setTab("activity")}>
              Activity
            </button>
          </div>
        )}

        <div className={cn("slideover-body pt-4", !isCreate && tab === "description" && editingDescription && "editor-flush")}>
        {tab === "description" ? (
        <>
        <TaskDescriptionSection
          isCreate={isCreate}
          slug={slug}
          task={task ?? null}
          emptyDoc={emptyDoc}
          taskTitles={taskTitles}
          taskKeys={taskKeys}
          editingDescription={editingDescription}
          setEditingDescription={setEditingDescription}
          setCreateDescription={setCreateDescription}
          onUpdate={onUpdate!}
        />

        {!isCreate && (
        <GitHubSection
          slug={slug ?? ""}
          taskId={task!.id}
          githubs={githubs}
          columnGithubState={columns?.find((column) => column.id === currentColumnId)?.githubState ?? null}
          onLink={onLinkGithub!}
          onUnlink={onUnlinkGithub!}
        />
        )}
        {!isCreate && slug && (
          <AttachmentsPanel slug={slug} taskId={task!.id} />
        )}
        </>
        ) : (
          <ActivityTab slug={slug} taskId={task?.id ?? ""} isArchived={isArchived} />
        )}
        </div>

        <TaskFooter
          isCreate={isCreate}
          isArchived={isArchived}
          creating={creating}
          createTitle={createTitle}
          createColumnId={createColumnId}
          onClose={handleClose}
          onCreate={handleCreate}
          onArchive={onArchive!}
          onRestore={onRestore!}
          onDeleteClick={() => setShowDeleteDialog(true)}
          taskId={task?.id ?? ""}
        />


      </dialog>

      {showDeleteDialog && task && (
        <DeleteTaskDialog
          task={task ?? null}
          open={showDeleteDialog}
          deleting={deleting}
          onClose={() => setShowDeleteDialog(false)}
          onDelete={handleConfirmDelete}
        />
      )}

    </>
  );
}
