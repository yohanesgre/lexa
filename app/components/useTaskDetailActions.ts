import { useState } from "react";
import type { TipTapDoc } from "../../shared/types";

interface UseTaskDetailActionsArgs {
  task: { id: string; columnId: string | null; swimlaneId: string | null; title: string } | null | undefined;
  defaultColumnId?: string | null;
  columns?: { id: string }[];
  fieldConfig?: { priorities: { id: string }[]; types: { id: string }[] };
  emptyDoc: TipTapDoc;
  onLinkGithub?: (id: string, repo: string) => Promise<{ repo: string; issueNumber: number } | null | undefined>;
  onUnlinkGithub?: (id: string, issueId: string) => Promise<void>;
  onCreate?: (input: { title: string; columnId: string; priority: string; type: string; assignees: string[]; description: TipTapDoc; dueAt?: string | null }) => Promise<void>;
  onClose: () => void;
}

export function useTaskDetailActions(args: UseTaskDetailActionsArgs) {
  const { task, defaultColumnId, columns, fieldConfig, emptyDoc, onLinkGithub, onUnlinkGithub, onCreate, onClose } = args;
  const [createTitle, setCreateTitle] = useState("");
  const [createColumnId, setCreateColumnId] = useState(defaultColumnId ?? (columns?.[0]?.id ?? ""));
  const [createPriority, setCreatePriority] = useState<string>(fieldConfig?.priorities[0]?.id ?? "");
  const [createType, setCreateType] = useState<string>(fieldConfig?.types[0]?.id ?? "");
  const [createAssignees, setCreateAssignees] = useState<string[]>([]);
  const [createDescription, setCreateDescription] = useState<TipTapDoc>(emptyDoc);
  const [createDueAt, setCreateDueAt] = useState("");
  const [creating, setCreating] = useState(false);

  const [prevTaskId, setPrevTaskId] = useState(task?.id ?? null);
  const [linkState, setLinkState] = useState<"idle" | "input" | "loading" | "success">("idle");
  const [linkRepo, setLinkRepo] = useState("");
  const [linkedIssue, setLinkedIssue] = useState<{ repo: string; number: number } | null>(null);
  if (prevTaskId !== (task?.id ?? null)) {
    setPrevTaskId(task?.id ?? null);
    setLinkState("idle");
    setLinkRepo("");
    setLinkedIssue(null);
  }

  const [selectedColumnId, setSelectedColumnId] = useState(task?.columnId ?? "");
  const [selectedSwimlaneId, setSelectedSwimlaneId] = useState(task?.swimlaneId ?? "");

  const [prevDefaultColumnId, setPrevDefaultColumnId] = useState(defaultColumnId ?? "");
  if (prevDefaultColumnId !== (defaultColumnId ?? "")) {
    setPrevDefaultColumnId(defaultColumnId ?? "");
    setCreateColumnId(defaultColumnId ?? "");
  }

  const [prevColumnId, setPrevColumnId] = useState(task?.columnId ?? "");
  if (prevColumnId !== (task?.columnId ?? "")) {
    setPrevColumnId(task?.columnId ?? "");
    setSelectedColumnId(task?.columnId ?? "");
  }

  const [prevSwimlaneId, setPrevSwimlaneId] = useState(task?.swimlaneId ?? "");
  if (prevSwimlaneId !== (task?.swimlaneId ?? "")) {
    setPrevSwimlaneId(task?.swimlaneId ?? "");
    setSelectedSwimlaneId(task?.swimlaneId ?? "");
  }

  const handleLinkIssue = async () => {
    if (!task || !linkRepo.trim()) return;
    setLinkState("loading");
    try {
      const linked = await onLinkGithub?.(task.id, linkRepo.trim());
      if (linked) setLinkedIssue({ repo: linked.repo, number: linked.issueNumber });
      setLinkState("success");
    } catch {
      setLinkState("idle");
    }
  };

  const handleUnlinkIssue = async (issueId: string) => {
    if (!task) return;
    try {
      await onUnlinkGithub?.(task.id, issueId);
    } catch {
      // error toast comes from the mutation
    }
  };

  const handleCreate = async () => {
    const title = createTitle.trim();
    if (!title || !createColumnId || !onCreate || creating) return;
    setCreating(true);
    try {
      await onCreate({
        title,
        columnId: createColumnId,
        priority: createPriority,
        type: createType,
        assignees: createAssignees,
        description: createDescription,
        dueAt: createDueAt === "" ? null : createDueAt,
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
    handleCreate,
  };
}
