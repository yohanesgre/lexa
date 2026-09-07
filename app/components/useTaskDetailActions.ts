import { useState } from "react";
import type { TipTapDoc } from "../../shared/types";

interface UseTaskDetailActionsArgs {
  task: { id: string; columnId: string | null; swimlaneId: string | null; title: string } | null | undefined;
  defaultColumnId?: string | null | undefined;
  columns?: { id: string }[] | undefined;
  fieldConfig?: { priorities: { id: string }[]; types: { id: string }[] } | undefined;
  emptyDoc: TipTapDoc;
  onLinkGithub?: ((id: string, repo: string) => Promise<{ repo: string; issueNumber: number } | null | undefined>) | undefined;
  onUnlinkGithub?: ((id: string, issueId: string) => Promise<void>) | undefined;
  onCreate?: ((input: { title: string; columnId: string; priority: string; type: string; assignees: string[]; description: TipTapDoc; dueAt?: string | null | undefined }) => Promise<void>) | undefined;
  onClose: () => void;
}

function taskKeyOf(task: UseTaskDetailActionsArgs["task"]) {
  return task?.id ?? null;
}

function initialCreateColumnId(defaultColumnId: string | null | undefined, columns: { id: string }[] | undefined) {
  return defaultColumnId ?? columns?.[0]?.id ?? "";
}

function firstOptionId(options: { id: string }[] | undefined) {
  return options?.[0]?.id ?? "";
}

function followValue(value: string | null | undefined) {
  return value ?? "";
}

function dueAtOrNull(dueAt: string) {
  return dueAt === "" ? null : dueAt;
}

function canCreate(title: string, createColumnId: string, onCreate: UseTaskDetailActionsArgs["onCreate"], creating: boolean) {
  return Boolean(title && createColumnId && onCreate && !creating);
}

function useFollow(value: string, apply: (value: string) => void) {
  const [prev, setPrev] = useState(value);
  if (prev !== value) {
    setPrev(value);
    apply(value);
  }
}

async function requestLinkIssue(
  task: UseTaskDetailActionsArgs["task"],
  linkRepo: string,
  onLinkGithub: UseTaskDetailActionsArgs["onLinkGithub"],
  setLinkState: (state: "idle" | "input" | "loading" | "success") => void,
  setLinkedIssue: (issue: { repo: string; number: number } | null) => void,
) {
  if (!task || !linkRepo.trim()) return;
  setLinkState("loading");
  try {
    const linked = await onLinkGithub?.(task.id, linkRepo.trim());
    if (linked) setLinkedIssue({ repo: linked.repo!, number: linked.issueNumber });
    setLinkState("success");
  } catch {
    setLinkState("idle");
  }
}

async function requestUnlinkIssue(
  task: UseTaskDetailActionsArgs["task"],
  issueId: string,
  onUnlinkGithub: UseTaskDetailActionsArgs["onUnlinkGithub"],
) {
  if (!task) return;
  try {
    await onUnlinkGithub?.(task.id, issueId);
  } catch {
    // error toast comes from the mutation
  }
}

export function useTaskDetailActions(args: UseTaskDetailActionsArgs) {
  const { task, defaultColumnId, columns, fieldConfig, emptyDoc, onLinkGithub, onUnlinkGithub, onCreate, onClose } = args;
  const [createTitle, setCreateTitle] = useState("");
  const [createColumnId, setCreateColumnId] = useState(() => initialCreateColumnId(defaultColumnId, columns));
  const [createPriority, setCreatePriority] = useState<string>(() => firstOptionId(fieldConfig?.priorities));
  const [createType, setCreateType] = useState<string>(() => firstOptionId(fieldConfig?.types));
  const [createAssignees, setCreateAssignees] = useState<string[]>([]);
  const [createDescription, setCreateDescription] = useState<TipTapDoc>(emptyDoc);
  const [createDueAt, setCreateDueAt] = useState("");
  const [creating, setCreating] = useState(false);

  const [linkState, setLinkState] = useState<"idle" | "input" | "loading" | "success">("idle");
  const [linkRepo, setLinkRepo] = useState("");
  const [linkedIssue, setLinkedIssue] = useState<{ repo: string; number: number } | null>(null);
  useFollow(taskKeyOf(task) ?? "", () => {
    setLinkState("idle");
    setLinkRepo("");
    setLinkedIssue(null);
  });

  const [selectedColumnId, setSelectedColumnId] = useState(task?.columnId ?? "");
  const [selectedSwimlaneId, setSelectedSwimlaneId] = useState(task?.swimlaneId ?? "");

  useFollow(followValue(defaultColumnId), (value) => {
    setCreateColumnId(value);
  });
  useFollow(followValue(task?.columnId ?? ""), (value) => {
    setSelectedColumnId(value);
  });
  useFollow(followValue(task?.swimlaneId ?? ""), (value) => {
    setSelectedSwimlaneId(value);
  });

  const handleLinkIssue = () => requestLinkIssue(task, linkRepo, onLinkGithub, setLinkState, setLinkedIssue);
  const handleUnlinkIssue = (issueId: string) => requestUnlinkIssue(task, issueId, onUnlinkGithub);

  const handleCreate = async () => {
    const title = createTitle.trim();
    if (!canCreate(title, createColumnId, onCreate, creating)) return;
    setCreating(true);
    try {
      await onCreate!({
        title,
        columnId: createColumnId,
        priority: createPriority,
        type: createType,
        assignees: createAssignees,
        description: createDescription,
        dueAt: dueAtOrNull(createDueAt),
      });
      onClose();
    } finally {
      setCreating(false);
    }
  };
  return {
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
    linkState, setLinkState,
    linkRepo, setLinkRepo,
    linkedIssue, setLinkedIssue,
    handleLinkIssue,
    handleUnlinkIssue,
    handleCreate,
  };
}
