import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import type { Board, Task, TipTapDoc, GithubIssue, Milestone, Swimlane } from "../../shared/types";
import { isEmptyDoc } from "../../shared/tiptap-text";
import { renderDoc } from "./tiptap-render";
import { GithubMark, TrashIcon, ArchiveIcon, LinkIcon } from "./icons";
import { TextEditor } from "./TextEditor";
import { SelectDropdown } from "./ui/SelectDropdown";
import { AssigneeChips } from "./AssigneeChips";
import { DescriptionEditor } from "./DescriptionEditor";
import { SlideoverHeader } from "./SlideoverHeader";
import { TaskPageBar } from "./TaskPageBar";
import { TaskTitleInput } from "./TaskTitleInput";
import { TaskNotFoundDialog, TaskNotFoundBody } from "./TaskNotFoundDialog";
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
import { laneNeighbors } from "../lib/lane-neighbors";
import { SourcesSection } from "./document/SourcesSection";
import { LinksSection } from "./document/LinksSection";
import { ActivityTab } from "./activity/ActivityTab";
import { cn } from "./ui/cn";

type RequiredFieldName = "assignee" | "description";

interface TaskDetailProps {
  mode?: "view" | "create";
  variant?: "slideover" | "page";
  from?: "board" | "tasks" | undefined;
  task?: Task | undefined;
  project?: { name: string };
  defaultColumnId?: string | undefined;
  defaultSwimlaneId?: string | undefined;
  showCreateSwimlane?: boolean | undefined;
  columns?: { id: string; name: string; githubState?: "open" | "closed" | null }[];
  swimlanes?: Swimlane[];
  milestones?: Milestone[];
  boardTasks?: Task[];
  columnRequiredFields?: { columnId: string; fields: string[] }[];
  availableAssignees?: string[];
  taskTitles?: Map<string, string>;    // taskId → title, for link display
  taskKeys?: Map<string, string>;      // taskId → key, for link display
  fieldConfig?: { priorities: { id: string; label: string; color: string }[]; types: { id: string; label: string; color: string }[] };
  onClose: () => void;
  onUpdate?: (id: string, data: Partial<Task>) => void;
  onMove?: (id: string, target: { columnId: string; swimlaneId: string; beforeTaskId?: string | undefined; afterTaskId?: string | undefined }) => void | Promise<void>;
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
    dueAt?: string | null | undefined;
    swimlaneId?: string | undefined;
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
    } else if (field === "description" && isEmptyDoc(values.description)) {
      missing.push("description");
    }
  }
  return missing;
}

function missingFieldsFor(isCreate: boolean, createColumnId: string, currentColumnId: string, columnRequiredFields: TaskDetailProps["columnRequiredFields"], task: Task | undefined, createAssignees: string[], createDescription: TipTapDoc): RequiredFieldName[] {
  return isCreate
    ? getMissingRequiredFields(createColumnId, columnRequiredFields, {
        assignees: createAssignees,
        description: createDescription,
      })
    : getMissingRequiredFields(currentColumnId, columnRequiredFields, {
        assignees: task?.assignees ?? [],
        description: task?.description ?? emptyDoc,
      });
}

interface DetailContext {
  currentColumnId: string;
  currentColumnName: string;
  currentSwimlaneName: string;
  isArchived: boolean;
  githubs: GithubIssue[];
  columnGithubState: "open" | "closed" | null;
}

function resolveDetailContext(args: {
  isCreate: boolean;
  task: Task | undefined;
  selectedColumnId: string;
  createColumnId: string;
  selectedSwimlaneId: string;
  columns: TaskDetailProps["columns"];
  swimlanes: TaskDetailProps["swimlanes"];
}): DetailContext {
  const currentColumnId = args.isCreate ? args.createColumnId : (args.selectedColumnId || args.task?.columnId || "");
  const column = args.columns?.find((c) => c.id === currentColumnId);
  return {
    currentColumnId,
    currentColumnName: column?.name ?? "",
    currentSwimlaneName: args.swimlanes?.find((lane) => lane.id === args.selectedSwimlaneId)?.name ?? "",
    isArchived: !args.isCreate && args.task != null && args.task.archivedAt != null,
    githubs: args.isCreate ? [] : args.task?.githubs ?? [],
    columnGithubState: column?.githubState ?? null,
  };
}

function slideoverClassName(open: boolean): string {
  return cn("slideover", "task-detail-panel", !open && "slideover-closed");
}

function overlayClassName(open: boolean): string {
  return cn("slideover-overlay", !open && "overlay-closed");
}

function useEscapeKey(enabled: boolean, showDeleteDialog: boolean, closeDeleteDialog: () => void, handleClose: () => void): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showDeleteDialog) {
          e.stopPropagation();
          closeDeleteDialog();
        } else {
          handleClose();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
}

function useTaskTitleEditing(task: Task | undefined, onUpdate: ((id: string, data: Partial<Task>) => void) | undefined) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [draft, setDraft] = useState(task?.title ?? "");
  const [prevTitle, setPrevTitle] = useState(task?.title);
  if (prevTitle !== task?.title && task?.title !== undefined) {
    setPrevTitle(task.title);
    setDraft(task.title);
  }
  const saveTitle = () => {
    const v = draft.trim();
    if (v && v !== task?.title) onUpdate?.(task!.id, { title: v });
    setEditingTitle(false);
  };
  return { editingTitle, setEditingTitle, draft, setDraft, saveTitle };
}

function useDismissableWarning(resetKey: string) {
  const [dismissed, setDismissed] = useState(false);
  const [prevKey, setPrevKey] = useState(resetKey);
  if (prevKey !== resetKey) {
    setPrevKey(resetKey);
    setDismissed(false);
  }
  return [dismissed, setDismissed] as const;
}

function useDeleteConfirmation(task: Task | undefined, onDelete: ((id: string) => Promise<void>) | undefined) {
  const [deleting, setDeleting] = useState(false);
  const confirmDelete = async () => {
    if (!task || !onDelete) return;
    setDeleting(true);
    try {
      await onDelete(task.id);
    } finally {
      setDeleting(false);
    }
  };
  return { deleting, confirmDelete };
}

function ArchivedBanner() {
  return (
    <div
      className="card-row flex items-center gap-2"
      style={{ background: "var(--lx-surface-elevated)", marginBottom: 12 }}
    >
      <ArchiveIcon size={14} />
      <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">
        Archived — not shown on the board unless "Show archived" is on
      </span>
    </div>
  );
}

function TaskTabsAndBody({ isCreate, tab, setTab, slug, task, editingDescription, setEditingDescription, setCreateDescription, onUpdate, taskTitles, taskKeys, githubs, columnGithubState, currentColumnId, onLinkGithub, onUnlinkGithub, isArchived }: {
  isCreate: boolean;
  tab: "description" | "activity";
  setTab: (tab: "description" | "activity") => void;
  slug: string | undefined;
  task: Task | undefined;
  editingDescription: boolean;
  setEditingDescription: (editing: boolean) => void;
  setCreateDescription: (doc: TipTapDoc) => void;
  onUpdate: (id: string, data: Partial<Task>) => void;
  taskTitles: Map<string, string> | undefined;
  taskKeys: Map<string, string> | undefined;
  githubs: GithubIssue[];
  columnGithubState: "open" | "closed" | null;
  currentColumnId: string;
  onLinkGithub: (id: string, repo: string) => Promise<{ repo: string; issueNumber: number } | null | undefined>;
  onUnlinkGithub: (id: string, issueId: string) => Promise<void>;
  isArchived: boolean;
}) {
  return (
    <>
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

      <div className="slideover-body pt-4">
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
              onUpdate={onUpdate}
            />

            {!isCreate && (
              <GitHubSection
                slug={slug ?? ""}
                taskId={task!.id}
                githubs={githubs}
                columnGithubState={columnGithubState}
                onLink={onLinkGithub}
                onUnlink={onUnlinkGithub}
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
    </>
  );
}

export function TaskDetail({ mode = "view", variant = "slideover", from, task, project, defaultColumnId, defaultSwimlaneId, showCreateSwimlane, columns, swimlanes, milestones, boardTasks, columnRequiredFields, availableAssignees, taskTitles, taskKeys, fieldConfig, onClose, onUpdate, onMove, onDelete, onArchive, onRestore, onLinkGithub, onUnlinkGithub, onCreate }: TaskDetailProps) {
  const params = useParams({ strict: false }) as { slug?: string };
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const slug = params.slug;
  const isCreate = mode === "create";
  const isPage = variant === "page";

  const [open, setOpen] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [editingAssignees, setEditingAssignees] = useState(false);
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
    if (isPage) {
      onClose();
      return;
    }
    setOpen(false);
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(onClose, 200);
  };

  const handleExpand = () => {
    if (!slug || !task) return;
    navigate({ to: "/$slug/tasks/$taskId", params: { slug, taskId: task.key || task.id }, search: { from } });
  };

  useEscapeKey(!isPage || showDeleteDialog, showDeleteDialog, () => setShowDeleteDialog(false), handleClose);

  const {
    selectedColumnId, setSelectedColumnId,
    selectedSwimlaneId, setSelectedSwimlaneId,
    createTitle, setCreateTitle,
    createColumnId, setCreateColumnId,
    createSwimlaneId, setCreateSwimlaneId,
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
    defaultSwimlaneId,
    columns,
    columnRequiredFields,
    fieldConfig,
    emptyDoc,
    onLinkGithub,
    onUnlinkGithub,
    onCreate,
    onClose: handleClose,
  });

  const handleMove = (id: string, target: { columnId: string; swimlaneId: string; beforeTaskId?: string | undefined; afterTaskId?: string | undefined }) => {
    if (!onMove) return;
    if (task && target.columnId === task.columnId && target.swimlaneId !== task.swimlaneId && !target.beforeTaskId && !target.afterTaskId) {
      const cached = queryClient.getQueryData<Board>(["board", slug, false]) ?? queryClient.getQueryData<Board>(["board", slug, true]);
      const tasks = cached?.tasks ?? boardTasks ?? [];
      return onMove(id, { ...target, ...laneNeighbors(tasks, task) });
    }
    return onMove(id, target);
  };

  const title = useTaskTitleEditing(task, onUpdate);
  const { deleting, confirmDelete } = useDeleteConfirmation(task, onDelete);
  const [archiveTogglePending, setArchiveTogglePending] = useState(false);
  // Guard double-clicks: one archive/restore in flight at a time.
  const runArchiveToggle = async (fn: ((id: string) => Promise<void>) | undefined, id: string) => {
    if (!fn || archiveTogglePending) return;
    setArchiveTogglePending(true);
    try {
      await fn(id);
    } finally {
      setArchiveTogglePending(false);
    }
  };

  const ctx = resolveDetailContext({
    isCreate,
    task,
    selectedColumnId,
    createColumnId,
    selectedSwimlaneId,
    columns,
    swimlanes,
  });
  const missingFields = missingFieldsFor(isCreate, createColumnId, ctx.currentColumnId, columnRequiredFields, task, createAssignees, createDescription);
  const [dismissedWarning, setDismissedWarning] = useDismissableWarning(`${ctx.currentColumnId}:${missingFields.join(",")}`);
  const [editingDescription, setEditingDescription] = useState(false);

  if (!isCreate && !task) {
    if (isPage) {
      return (
        <main className="page-frame page-frame-narrow">
          <div className="task-page">
            <TaskPageBar slug={slug} project={project ?? null} onBack={handleClose} />
            <TaskNotFoundBody message="This task was deleted or the link is stale." onClose={handleClose} />
          </div>
        </main>
      );
    }
    return <TaskNotFoundDialog open={open} onClose={handleClose} />;
  }

  const inner = (
    <>
      {isPage ? (
        <TaskPageBar slug={slug} project={project ?? null} onBack={handleClose} />
      ) : (
        <SlideoverHeader
          slug={slug}
          project={project ?? null}
          isCreate={isCreate}
          onExpand={isCreate ? undefined : handleExpand}
          onClose={handleClose}
        />
      )}

        <div className={cn("pt-4", !isPage && "px-4")}>
          {ctx.isArchived && <ArchivedBanner />}
          <TaskTitleInput
            isArchived={ctx.isArchived}
            isCreate={isCreate}
            createTitle={createTitle}
            setCreateTitle={setCreateTitle}
            onCreate={handleCreate}
            onClose={handleClose}
            editingTitle={title.editingTitle}
            draft={title.draft}
            setDraft={title.setDraft}
            onSaveTitle={title.saveTitle}
            setEditingTitle={title.setEditingTitle}
            taskTitle={task?.title ?? ""}
            taskKey={task?.key ?? ""}
            slug={slug}
          />
        </div>

        <TaskPropertyBar
          isCreate={isCreate}
          task={task ?? null}
          columns={columns}
          swimlanes={swimlanes}
          milestones={milestones}
          fieldConfig={fieldConfig}
          missingFields={missingFields}
          currentColumnName={ctx.currentColumnName}
          currentSwimlaneName={ctx.currentSwimlaneName}
          selectedColumnId={selectedColumnId}
          setSelectedColumnId={setSelectedColumnId}
          selectedSwimlaneId={selectedSwimlaneId}
          setSelectedSwimlaneId={setSelectedSwimlaneId}
          onUpdate={onUpdate!}
          onMove={handleMove}
          createColumnId={createColumnId}
          setCreateColumnId={setCreateColumnId}
          createSwimlaneId={createSwimlaneId}
          setCreateSwimlaneId={setCreateSwimlaneId}
          showCreateSwimlane={showCreateSwimlane}
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
            columnName={ctx.currentColumnName}
            fields={missingFields}
            onDismiss={() => setDismissedWarning(true)}
          />
        )}

        <TaskTabsAndBody
          isCreate={isCreate}
          tab={tab}
          setTab={setTab}
          slug={slug}
          task={task}
          editingDescription={editingDescription}
          setEditingDescription={setEditingDescription}
          setCreateDescription={setCreateDescription}
          onUpdate={onUpdate!}
          taskTitles={taskTitles}
          taskKeys={taskKeys}
          githubs={ctx.githubs}
          columnGithubState={ctx.columnGithubState}
          currentColumnId={ctx.currentColumnId}
          onLinkGithub={onLinkGithub!}
          onUnlinkGithub={onUnlinkGithub!}
          isArchived={ctx.isArchived}
        />

        <TaskFooter
          isCreate={isCreate}
          isArchived={ctx.isArchived}
          creating={creating}
          archivePending={archiveTogglePending}
          createTitle={createTitle}
          createColumnId={createColumnId}
          createBlocked={missingFields.length > 0}
          onClose={handleClose}
          onCreate={handleCreate}
          onArchive={(id) => { void runArchiveToggle(onArchive, id); }}
          onRestore={(id) => { void runArchiveToggle(onRestore, id); }}
          onDeleteClick={() => setShowDeleteDialog(true)}
          taskId={task?.id ?? ""}
        />
    </>
  );

  return (
    <>
      {!isPage && <button type="button" className={overlayClassName(open)} onClick={handleClose} aria-label="Close" />}
      {isPage ? (
        <div className="task-page">{inner}</div>
      ) : (
        <dialog open className={slideoverClassName(open)} aria-modal="true" aria-label="Task details">
          {inner}
        </dialog>
      )}

      {showDeleteDialog && task && (
        <DeleteTaskDialog
          task={task}
          open={showDeleteDialog}
          deleting={deleting}
          onClose={() => setShowDeleteDialog(false)}
          onDelete={confirmDelete}
        />
      )}
    </>
  );
}
