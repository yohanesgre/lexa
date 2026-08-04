import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { Check, ChevronDown, X } from "lucide-react";
import type { Task, TipTapDoc, GithubIssue } from "../../shared/types";
import { extractText } from "../../shared/tiptap-text";
import { renderDoc } from "./tiptap-render";
import { TextEditor } from "./TextEditor";
import { Toolbar } from "./TextEditor";
import { textEditorExtensions } from "../lib/tiptap";
import { SourcesSection } from "./forge/SourcesSection";
import { LinksSection } from "./forge/LinksSection";
import { ForgeReviewSurface } from "./forge/ForgeReviewSurface";
import { useForgeReview } from "./forge/useForgeReview";
import { cn } from "./ui/cn";
import { useEditor, EditorContent } from "@tiptap/react";
import type { JSONContent } from "@tiptap/core";

function GithubMark({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      className={className}
    >
      <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77 5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
    </svg>
  );
}

function TrashIcon({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      className={className}
    >
      <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function ArchiveIcon({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      className={className}
    >
      <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function LinkIcon({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      className={className}
    >
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

type RequiredFieldName = "assignee" | "description";

interface TaskDetailProps {
  mode?: "view" | "create";
  task?: Task;
  project?: { name: string };
  defaultColumnId?: string;
  columns?: { id: string; name: string }[];
  swimlanes?: { id: string; name: string }[];
  columnRequiredFields?: { columnId: string; fields: string[] }[];
  availableAssignees?: string[];
  taskTitles?: Map<string, string>;    // taskId → title, for link display
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
  }) => Promise<void>;
}

interface SelectOption {
  value: string;
  label: React.ReactNode;
}

interface SelectDropdownProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  trigger: (props: { open: boolean; toggle: () => void }) => React.ReactNode;
}

function SelectDropdown({ value, options, onChange, trigger }: SelectDropdownProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function handleMouseDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const toggle = () => setOpen((v) => !v);

  return (
    <div ref={containerRef} className="relative inline-flex">
      {trigger({ open, toggle })}
      {open && (
        <div className={cn("menu-popover", "left")}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              className={cn("menu-item", option.value === value && "active")}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              {option.value === value && <Check size={14} strokeWidth={2} />}
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface AssigneeChipsProps {
  assignees: string[];
  availableAssignees: string[];
  placeholder?: string;
  inputClassName?: string;
  inputStyle?: React.CSSProperties;
  onChange?: (assignees: string[]) => void;
  readonly?: boolean;
  compact?: boolean;
  expanded?: boolean;
}

function AssigneeChips({
  assignees,
  availableAssignees,
  placeholder,
  inputClassName,
  inputStyle,
  onChange,
  readonly,
  compact,
  expanded = false,
}: AssigneeChipsProps) {
  const [localExpanded, setLocalExpanded] = useState(false);
  const isExpanded = expanded || localExpanded;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function handleMouseDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const assigneesSet = new Set(assignees);
  const suggestions = availableAssignees.filter(
    (a) => !assigneesSet.has(a) && (!draft || a.toLowerCase().includes(draft.toLowerCase()))
  );

  const handleAdd = (name: string) => {
    onChange?.([...assignees, name]);
    setDraft("");
    setOpen(false);
  };

  const handleRemove = (name: string) => {
    onChange?.(assignees.filter((a) => a !== name));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && draft.trim() && !assignees.includes(draft.trim())) {
      e.preventDefault();
      handleAdd(draft.trim());
    }
  };

  if (readonly) {
    const visible = compact && !isExpanded ? assignees.slice(0, 3) : assignees;
    const overflow = compact && !isExpanded ? assignees.length - 3 : 0;
    return (
      <>
        {visible.map((a) => (
          <span key={a} className="assignee-chip">
            <span className="avatar">{a.slice(0, 2).toUpperCase()}</span>
            <span className="text-sm text-lx-text-primary font-medium">{a}</span>
          </span>
        ))}
        {overflow > 0 && (
          <button
            type="button"
            className="assignee-chip"
            style={{ opacity: 0.6, cursor: "pointer", border: "none", background: "none", font: "inherit" }}
            onClick={() => setLocalExpanded(true)}
            title="Show all assignees"
          >
            <span className="avatar">+{overflow}</span>
          </button>
        )}
        {compact && isExpanded && (
          <button
            type="button"
            className="assignee-chip"
            style={{ opacity: 0.6, cursor: "pointer", border: "none", background: "none", font: "inherit" }}
            onClick={() => setLocalExpanded(false)}
            title="Collapse"
          >
            <span className="avatar" style={{ fontSize: 10 }}>-</span>
          </button>
        )}
      </>
    );
  }

  return (
    <>
      <input
        className={inputClassName}
        style={inputStyle}
        value={draft}
        placeholder={placeholder}
        onFocus={() => {
          if (availableAssignees.length > 0) setOpen(true);
        }}
        onChange={(e) => {
          setDraft(e.target.value);
          if (!open && availableAssignees.length > 0) setOpen(true);
        }}
        onKeyDown={handleKeyDown}
        onBlur={(e) => {
          const related = e.relatedTarget as Node | null;
          if (containerRef.current && related && containerRef.current.contains(related)) {
            return;
          }
          if (draft.trim() && !assignees.includes(draft.trim())) {
            handleAdd(draft.trim());
          }
        }}
      />
      {assignees.map((a) => (
        <span key={a} className="assignee-chip">
          <span className="avatar">{a.slice(0, 2).toUpperCase()}</span>
          <span className="text-sm text-lx-text-primary font-medium">{a}</span>
          <button type="button" className="assignee-chip-x" aria-label={`Remove assignee ${a}`} onClick={() => handleRemove(a)}>
            <X size={10} strokeWidth={2} />
          </button>
        </span>
      ))}
      {open && suggestions.length > 0 && (
        <div className="dropdown-menu" style={{ position: "absolute", top: "100%", left: 0, zIndex: 60 }}>
          <div className="dropdown-label">Members</div>
          {suggestions.map((name) => (
            <button
              key={name}
              type="button"
              className={cn("dropdown-item", assigneesSet.has(name) && "active")}
              onClick={() => handleAdd(name)}
            >
              <span className="avatar">{name.slice(0, 2).toUpperCase()}</span>
              <div>
                <div className="text-sm font-medium text-lx-text-primary">{name}</div>
                <div className="font-mono text-2xs text-lx-text-muted">{name.toLowerCase()}@example.com</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </>
  );
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

interface DescriptionEditorProps {
  initialContent: TipTapDoc;
  onChange?: (doc: TipTapDoc) => void;
  onBlur?: (doc: TipTapDoc) => void;
  onDone?: (doc: TipTapDoc) => void;
  onCancel?: () => void;
  placeholder?: string;
  editable?: boolean;
  forge?: { slug: string; documentType: "task" | "wiki"; documentId: string };
  onReviewStateChange?: (active: boolean) => void;
}

function DescriptionEditor({
  initialContent,
  onChange,
  onBlur,
  onDone,
  onCancel,
  placeholder,
  editable = true,
  forge,
  onReviewStateChange,
}: DescriptionEditorProps) {
  const onBlurRef = useRef(onBlur);
  const onChangeRef = useRef(onChange);
  const onDoneRef = useRef(onDone);
  const onCancelRef = useRef(onCancel);
  useEffect(() => {
    onBlurRef.current = onBlur;
    onChangeRef.current = onChange;
    onDoneRef.current = onDone;
    onCancelRef.current = onCancel;
  });
  // Forge review end: persist whatever the doc holds now (the accepted
  // replacement) via the same save path as Done. Reject leaves the doc
  // untouched — stay in edit mode.
  const handleReviewStateChange = (active: boolean, accepted: boolean) => {
    onReviewStateChange?.(active);
    if (!active && accepted && onDoneRef.current && editorRef.current) {
      onDoneRef.current(editorRef.current.getJSON() as unknown as TipTapDoc);
    }
  };
  const wrapperRef = useRef<HTMLDivElement>(null);
  const lastPointerDownInside = useRef(false);
  const editorRef = useRef<NonNullable<ReturnType<typeof useEditor>> | null>(null);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      lastPointerDownInside.current =
        wrapperRef.current?.contains(target) === true || target?.closest("[data-forge-popover]") !== null;
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: textEditorExtensions,
    content: initialContent as unknown as JSONContent,
    editable,
    onUpdate: ({ editor: nextEditor }) => {
      onChangeRef.current?.(nextEditor.getJSON() as unknown as TipTapDoc);
    },
    onBlur: ({ editor: ed }) => {
      onBlurRef.current?.(ed.getJSON() as unknown as TipTapDoc);
    },
    onCreate: ({ editor: ed }) => {
      editorRef.current = ed;
    },
    editorProps: {
      handleKeyDown: (_view, event) => {
        // Enter (not during IME composition) finishes editing; Esc reverts.
        if (event.key === "Enter" && !event.isComposing && !event.shiftKey) {
          event.preventDefault();
          const doc = editor?.getJSON() as unknown as TipTapDoc | undefined;
          if (doc) onDoneRef.current?.(doc);
          return true;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          onCancelRef.current?.();
          return true;
        }
        return false;
      },
      handleDOMEvents: {
        // Returning true stops ProseMirror's focusEvents plugin, so the
        // editor never reports a blur when focus moves within its own chrome
        // (toolbar, done/cancel buttons) and onBlur doesn't exit edit mode.
        // A blur with null relatedTarget (browser quirk when a selection is
        // active, or prompt dialogs) is only kept when the pointer went down
        // inside the chrome.
        blur: (_view, event) => {
          const related = (event as FocusEvent).relatedTarget as HTMLElement | null;
          if (related !== null) {
            return wrapperRef.current?.contains(related) === true || related?.closest("[data-forge-popover]") !== null;
          }
          return lastPointerDownInside.current;
        },
      },
    },
  });

  const { review, appliedTaskId, handleReview, handleAcceptReview, handleRejectReview } = useForgeReview(editor, handleReviewStateChange);

  if (!editor) return null;

  const headingLevel = (editor.getAttributes("heading").level as number | undefined) ?? 0;

  const handleDone = () => {
    onDoneRef.current?.(editor.getJSON() as unknown as TipTapDoc);
  };

  return (
    <div className={cn("editor-wrapper", review && "is-reviewing")} ref={wrapperRef}>
      {onDone && (
        <div
          className="flex items-center justify-between"
          style={{ padding: "6px 8px 6px 12px", borderBottom: "1px solid var(--lx-border-default)", borderRadius: "6px 6px 0 0", background: "var(--lx-surface-card)" }}
        >
          <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">Editing description</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn btn-ghost btn-icon-sm"
              style={{ width: 28, height: 28, padding: 0 }}
              onClick={() => onCancelRef.current?.()}
              title="Revert changes (Esc)"
              aria-label="Revert changes"
            >
              <X size={13} strokeWidth={2} />
            </button>
            <button
              type="button"
              className="btn btn-primary btn-icon-sm"
              style={{ width: 28, height: 28, padding: 0 }}
              onClick={handleDone}
              title="Save and finish (Enter)"
              aria-label="Save and finish editing"
            >
              <Check size={13} strokeWidth={2.5} />
            </button>
          </div>
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", borderBottom: "1px solid var(--lx-border-default)" }}>
        <Toolbar editor={editor} headingLevel={headingLevel} forge={forge} reviewActive={review !== null} appliedTaskId={appliedTaskId} onReview={handleReview} />
      </div>
      {review && (
        <ForgeReviewSurface action={review.action} runtime={review.runtime} diff={review.diff} onAccept={handleAcceptReview} onReject={handleRejectReview} />
      )}
      <EditorContent editor={editor} className="editor-content" />
    </div>
  );
}

export function TaskDetail({ mode = "view", task, project, defaultColumnId, columns, swimlanes, columnRequiredFields, availableAssignees, taskTitles, fieldConfig, onClose, onUpdate, onMove, onDelete, onArchive, onRestore, onLinkGithub, onUnlinkGithub, onCreate }: TaskDetailProps) {
  const params = useParams({ strict: false }) as { slug?: string };
  const slug = params.slug;
  const isCreate = mode === "create";

  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [selectedColumnId, setSelectedColumnId] = useState(task?.columnId ?? "");
  const [selectedSwimlaneId, setSelectedSwimlaneId] = useState(task?.swimlaneId ?? "");
  const [dismissedWarning, setDismissedWarning] = useState(false);
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

  const [createTitle, setCreateTitle] = useState("");
  const [createColumnId, setCreateColumnId] = useState(defaultColumnId ?? (columns?.[0]?.id ?? ""));
  const [createPriority, setCreatePriority] = useState<string>(fieldConfig?.priorities[0]?.id ?? "");
  const [createType, setCreateType] = useState<string>(fieldConfig?.types[0]?.id ?? "");
  const [createAssignees, setCreateAssignees] = useState<string[]>([]);
  const [createDescription, setCreateDescription] = useState<TipTapDoc>(emptyDoc);
  const [creating, setCreating] = useState(false);

  const [linkState, setLinkState] = useState<"idle" | "input" | "loading" | "success">("idle");
  const [linkRepo, setLinkRepo] = useState("");
  const [linkedIssue, setLinkedIssue] = useState<{ repo: string; number: number } | null>(null);

  useEffect(() => {
    if (defaultColumnId) setCreateColumnId(defaultColumnId);
  }, [defaultColumnId]);

  useEffect(() => {
    if (task?.columnId) setSelectedColumnId(task.columnId);
  }, [task?.columnId]);

  useEffect(() => {
    if (task?.swimlaneId) setSelectedSwimlaneId(task.swimlaneId);
  }, [task?.swimlaneId]);

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
      });
      handleClose();
    } finally {
      setCreating(false);
    }
  };

  const [editingTitle, setEditingTitle] = useState(false);
  const [editingDescription, setEditingDescription] = useState(false);
  const [editingAssignees, setEditingAssignees] = useState(false);
  const [draft, setDraft] = useState(task?.title ?? "");

  useEffect(() => {
    if (task?.title !== undefined) setDraft(task.title);
  }, [task?.title]);

  const [prevTaskId, setPrevTaskId] = useState(task?.id ?? null);
  if (prevTaskId !== (task?.id ?? null)) {
    setPrevTaskId(task?.id ?? null);
    setLinkState("idle");
    setLinkRepo("");
    setLinkedIssue(null);
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
    return (
      <>
        <button type="button" className={cn("slideover-overlay", !open && "overlay-closed")} onClick={handleClose} aria-label="Close" />
        <dialog open className={cn("slideover", !open && "slideover-closed")} aria-modal="true" aria-label="Task details">
          <div className="slideover-header border-b border-lx-border-subtle">
            <span className="text-xs font-body text-lx-text-muted">Board</span>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <button type="button" className="btn btn-ghost !w-8 !h-8 !p-0" onClick={handleClose} aria-label="Close">
                <X size={18} strokeWidth={1.5} />
              </button>
            </div>
          </div>
          <div className="slideover-body flex items-center justify-center" style={{ flexDirection: "column", gap: 12 }}>
            <div className="empty-state-icon">
              <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 8v4M12 16h.01" />
              </svg>
            </div>
            <div className="empty-state-title">Task not found</div>
            <div className="empty-state-desc">This task was deleted or the link is stale.</div>
            <button type="button" className="btn btn-primary" style={{ marginTop: 8 }} onClick={handleClose}>
              Close
            </button>
          </div>
        </dialog>
      </>
    );
  }

  const githubs: GithubIssue[] = isCreate ? [] : task?.githubs ?? [];

  return (
    <>
      <button type="button" className={cn("slideover-overlay", !open && "overlay-closed")} onClick={handleClose} aria-label="Close" />
      <dialog open className={cn("slideover", expanded && "slideover-expanded", !open && "slideover-closed")} aria-modal="true" aria-label="Task details">
        <div className="slideover-header border-b border-lx-border-subtle">
          {isCreate ? (
            <span className="text-xs font-body text-lx-text-muted">
              {slug ? (
                <>
                  <Link to="/$slug" params={{ slug }} search={{}} className="text-lx-text-muted hover:text-lx-text-secondary">
                    {project?.name ?? slug}
                  </Link>
                  {" / Board / "}
                </>
              ) : (
                "Board / "
              )}
              <span className="text-lx-text-secondary font-medium">New task</span>
            </span>
          ) : (
            <span className="text-xs font-body text-lx-text-muted">
              {slug ? (
                <>
                  <Link to="/$slug" params={{ slug }} search={{}} className="text-lx-text-muted hover:text-lx-text-secondary">
                    {project?.name ?? slug}
                  </Link>
                  {" / Board"}
                </>
              ) : (
                "Board"
              )}
            </span>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <button type="button"
              className="btn btn-ghost !w-8 !h-8 !p-0"
              onClick={() => setExpanded((v) => !v)}
              aria-label={expanded ? "Shrink width" : "Expand width"}
              title={expanded ? "Toggle width (full width → 480px)" : "Toggle width (480px → full width)"}
            >
              {expanded ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                  <path d="M4 14h6v6M20 10h-6V4M14 14l7-7M10 10l-7 7" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                  <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
                </svg>
              )}
            </button>
            <button type="button" className="btn btn-ghost !w-8 !h-8 !p-0" onClick={handleClose} aria-label="Close">
              <X size={18} strokeWidth={1.5} />
            </button>
          </div>
        </div>

        <div className="px-4 pt-4">
          {isArchived && (
            <div
              className="flex items-center gap-2"
              style={{ background: "var(--lx-surface-elevated)", border: "1px solid var(--lx-border-default)", borderRadius: 6, padding: "8px 12px", marginBottom: 12 }}
            >
              <ArchiveIcon size={14} />
              <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">
                Archived — not shown on the board unless "Show archived" is on
              </span>
            </div>
          )}
          {isCreate ? (
            <input
              className="slideover-title-input"
              aria-label="Task title"
              placeholder="Task title..."
              value={createTitle}
              autoFocus
              onChange={(e) => setCreateTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
                if (e.key === "Escape") {
                  e.stopPropagation();
                  handleClose();
                }
              }}
            />
          ) : editingTitle ? (
            <input
              className="slideover-title-input"
              aria-label="Task title"
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveTitle();
                if (e.key === "Escape") {
                  setDraft(task!.title);
                  setEditingTitle(false);
                  e.stopPropagation();
                }
              }}
            />
          ) : (
            <button
              type="button"
              className="slideover-title"
              style={{ border: "none", background: "none", padding: 0, textAlign: "left", cursor: "pointer" }}
              onClick={() => {
                setDraft(task!.title);
                setEditingTitle(true);
              }}
              title="Click to edit"
            >
              {task?.title}
            </button>
          )}
        </div>

        <div className="property-bar mt-3">
          <div className="prop-field">
            <span className="prop-label">Column</span>
            {isCreate ? (
              <select
                className="prop-input"
                aria-label="Column"
                style={{ minWidth: 120 }}
                value={createColumnId}
                onChange={(e) => setCreateColumnId(e.target.value)}
              >
                {(columns ?? []).map((column) => (
                  <option key={column.id} value={column.id}>
                    {column.name}
                  </option>
                ))}
              </select>
            ) : (
              <SelectDropdown
                value={selectedColumnId}
                options={(columns ?? []).map((col) => ({
                  value: col.id,
                  label: col.name,
                }))}
                onChange={(columnId) => {
                  setSelectedColumnId(columnId);
                  onUpdate?.(task!.id, { columnId });
                }}
                trigger={({ open, toggle }) => (
                  <button
                    type="button"
                    className={cn("prop-input", missingFields.length > 0 && "is-focused")}
                    style={{ minWidth: 120, height: 32, justifyContent: "space-between", display: "inline-flex", alignItems: "center" }}
                    onClick={toggle}
                  >
                    <span>{currentColumnName || "—"}</span>
                    <ChevronDown size={14} className={cn("transition-transform", open && "rotate-180")} />
                  </button>
                )}
              />
            )}
          </div>
          {!isCreate && (swimlanes?.length ?? 0) > 0 && (
            <div className="prop-field">
              <span className="prop-label">Swimlane</span>
              <SelectDropdown
                value={selectedSwimlaneId}
                options={(swimlanes ?? []).map((lane) => ({
                  value: lane.id,
                  label: lane.name,
                }))}
                onChange={(swimlaneId) => {
                  setSelectedSwimlaneId(swimlaneId);
                  onMove?.(task!.id, { columnId: task!.columnId, swimlaneId });
                }}
                trigger={({ open, toggle }) => (
                  <button
                    type="button"
                    className="prop-input"
                    style={{ minWidth: 120, height: 32, justifyContent: "space-between", display: "inline-flex", alignItems: "center" }}
                    onClick={toggle}
                  >
                    <span>{currentSwimlaneName || "—"}</span>
                    <ChevronDown size={14} className={cn("transition-transform", open && "rotate-180")} />
                  </button>
                )}
              />
            </div>
          )}
          <div className="prop-field">
            <span className="prop-label">Priority</span>
            {isCreate ? (
              <SelectDropdown
                value={createPriority}
                options={(fieldConfig?.priorities ?? []).map((priority) => ({
                  value: priority.id,
                  label: (
                    <>
                      <span className="priority-dot" style={{ background: priority.color }} />
                      {priority.label}
                    </>
                  ),
                }))}
                onChange={(priority) => setCreatePriority(priority)}
                trigger={({ toggle }) => {
                  const opt = (fieldConfig?.priorities ?? []).find((p) => p.id === createPriority);
                  return (
                    <button type="button" className="priority-badge" onClick={toggle} style={{ boxShadow: "var(--lx-focus-glow)", color: opt?.color, background: `${opt?.color ?? "#6b6560"}1a` }}>
                      <span className="priority-dot" style={{ background: opt?.color ?? "#6b6560" }} />
                      {opt?.label ?? "—"}
                    </button>
                  );
                }}
              />
            ) : (
              <SelectDropdown
                value={task!.priority}
                options={(fieldConfig?.priorities ?? []).map((priority) => ({
                  value: priority.id,
                  label: (
                    <>
                      <span className="priority-dot" style={{ background: priority.color }} />
                      {priority.label}
                    </>
                  ),
                }))}
                onChange={(priority) => onUpdate?.(task!.id, { priority })}
                trigger={({ toggle }) => {
                  const opt = (fieldConfig?.priorities ?? []).find((p) => p.id === task!.priority);
                  return (
                    <button type="button" className="priority-badge" onClick={toggle} style={{ color: opt?.color, background: `${opt?.color ?? "#6b6560"}1a` }}>
                      <span className="priority-dot" style={{ background: opt?.color ?? "#6b6560" }} />
                      {opt?.label ?? "—"}
                    </button>
                  );
                }}
              />
            )}
          </div>
          <div className="prop-field">
            <span className="prop-label">Type</span>
            {isCreate ? (
              <SelectDropdown
                value={createType}
                options={(fieldConfig?.types ?? []).map((type) => ({
                  value: type.id,
                  label: (
                    <span className="type-badge" style={{ background: `${type.color}1a`, color: type.color }}>
                      {type.label}
                    </span>
                  ),
                }))}
                onChange={(type) => setCreateType(type)}
                trigger={({ toggle }) => {
                  const opt = (fieldConfig?.types ?? []).find((t) => t.id === createType);
                  return (
                    <button type="button" className="type-badge" onClick={toggle} style={{ background: `${opt?.color ?? "#6b7280"}1a`, color: opt?.color ?? "#6b7280", boxShadow: "var(--lx-focus-glow)", borderRadius: 4 }}>
                      {opt?.label ?? "—"}
                    </button>
                  );
                }}
              />
            ) : (
              <SelectDropdown
                value={task!.type}
                options={(fieldConfig?.types ?? []).map((type) => ({
                  value: type.id,
                  label: (
                    <span className="type-badge" style={{ background: `${type.color}1a`, color: type.color }}>
                      {type.label}
                    </span>
                  ),
                }))}
                onChange={(type) => onUpdate?.(task!.id, { type })}
                trigger={({ toggle }) => {
                  const opt = (fieldConfig?.types ?? []).find((t) => t.id === task!.type);
                  return (
                    <button type="button" className="type-badge" onClick={toggle} style={{ background: `${opt?.color ?? "#6b7280"}1a`, color: opt?.color ?? "#6b7280" }}>
                      {opt?.label ?? "—"}
                    </button>
                  );
                }}
              />
            )}
          </div>
          {isCreate || editingAssignees ? (
            <div className="prop-field" style={{ flexWrap: "wrap" }}>
              <span className="prop-label">Assignees</span>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ width: 20, height: 20, padding: 0, flexShrink: 0 }}
                onClick={() => setEditingAssignees(false)}
                title="Done editing assignees"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              </button>
              <AssigneeChips
                key={isCreate ? "create" : task!.id}
                assignees={isCreate ? createAssignees : task!.assignees ?? []}
                availableAssignees={availableAssignees ?? []}
                placeholder="Add assignee..."
                inputClassName={cn("prop-input", missingFields.includes("assignee") && "is-focused")}
                inputStyle={{ minWidth: 120, maxWidth: 120, padding: "6px 8px", border: "1px solid var(--lx-border-focus)", borderRadius: 6 }}
                onChange={isCreate
                  ? setCreateAssignees
                  : (next) => onUpdate?.(task!.id, { assignees: next })}
              />
            </div>
          ) : (
            <div className="prop-field">
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <span className="prop-label">Assignees</span>
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ width: 20, height: 20, padding: 0 }}
                  onClick={() => setEditingAssignees(true)}
                  title="Edit assignees"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                </button>
              </div>
              <AssigneeChips
                readonly
                compact
                assignees={task!.assignees ?? []}
                availableAssignees={availableAssignees ?? []}
              />
            </div>
          )}
        </div>

        {missingFields.length > 0 && !dismissedWarning && (
          <div className="px-4 pt-3">
            <div className="banner-warning">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                style={{ flexShrink: 0 }}
              >
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01" />
              </svg>
              <span className="font-medium">{currentColumnName} requires {missingFields.join(", ")}</span>
              <button
                type="button"
                className="banner-warning-dismiss"
                onClick={() => setDismissedWarning(true)}
                aria-label="Dismiss warning"
              >
                <X size={14} strokeWidth={1.5} />
              </button>
            </div>
          </div>
        )}

        <div className="slideover-body pt-4">
          {isCreate ? (
            <>
              <DescriptionEditor
                initialContent={emptyDoc}
                onChange={setCreateDescription}
                placeholder="Add a description..."
                forge={slug ? { slug, documentType: "task", documentId: task?.id ?? "" } : undefined}
              />
              <div className="mt-4 border border-dashed border-lx-border-default rounded-md p-3 text-xs text-lx-text-muted font-body">
                No GitHub section in create mode — linking is available after the task exists.
              </div>
            </>
          ) : (
            <>
              {editingDescription ? (
                <DescriptionEditor
                  initialContent={task!.description}
                  editable={true}
                  forge={slug ? { slug, documentType: "task", documentId: task!.id } : undefined}
                  onBlur={(doc) => {
                    onUpdate?.(task!.id, { description: doc });
                    setEditingDescription(false);
                  }}
                  onDone={(doc) => {
                    onUpdate?.(task!.id, { description: doc });
                    setEditingDescription(false);
                  }}
                  onCancel={() => {
                    setEditingDescription(false);
                  }}
                />
              ) : (
                <div className="td-prose" onDoubleClick={() => setEditingDescription(true)}>
                  {renderDoc(task!.description, "task")}
                </div>
              )}

              {!isCreate && slug && (
                <LinksSection
                  slug={slug}
                  taskId={task!.id}
                  taskTitleById={taskTitles}
                  className="mt-4 pt-4 border-t border-lx-border-subtle"
                />
              )}
              {!isCreate && slug && (
                <SourcesSection
                  slug={slug}
                  documentType="task"
                  documentId={task!.id}
                  className="mt-4 pt-4 border-t border-lx-border-subtle"
                />
              )}
              <div className="github-section mt-4 pt-4">
                {githubs.length > 0 ? (
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <GithubMark size={14} className="text-lx-text-muted" />
                      <span className="prop-label">GitHub Issues</span>
                      <button type="button" className="btn btn-ghost" style={{ height: 24, padding: "0 8px", fontSize: 11 }} onClick={() => setLinkState("input")}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 5v14m-7-7h14"/></svg>
                        Link issue
                      </button>
                    </div>
                    <div>
                    {githubs.map(g => (
                      <div key={g.issueId} className={cn("github-issue-row", g.outOfSync && "github-warning")}>
                        <div className="flex items-center justify-between w-full">
                          <a href={g.url} target="_blank" rel="noreferrer" className="flex items-center gap-2">
                            <GithubMark size={14} className="text-lx-text-link" />
                            <span className="font-mono text-sm font-medium text-lx-text-link">
                              {g.repo} #{g.issueNumber}
                            </span>
                          </a>
                          <div className="flex items-center gap-1">
                            <div className="flex items-center gap-2">
                              <span className={cn("sync-dot", g.outOfSync ? "sync-diverged" : "sync-synced")} />
                              <span
                                className={cn(
                                  "font-micro text-2xs uppercase tracking-[0.04em]",
                                  g.outOfSync ? "text-lx-text-warning" : "text-lx-text-success"
                                )}
                              >
                                {g.outOfSync ? "Diverged" : "Synced"}
                              </span>
                            </div>
                            <button
                              type="button"
                              className="btn btn-ghost !w-6 !h-6 !p-0"
                              title="Unlink issue"
                              onClick={() => handleUnlinkIssue(g.issueId)}
                            >
                              <X size={12} strokeWidth={1.5} />
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                    </div>
                ) : (
                  <>
                    {linkState === "success" && linkedIssue ? (
                      <div className="github-link-success">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <GithubMark size={14} className="text-lx-text-link" />
                            <span className="font-mono text-sm font-medium text-lx-text-link">
                              {linkedIssue.repo} #{linkedIssue.number}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="sync-dot sync-synced" />
                            <span className="font-micro text-2xs uppercase tracking-[0.04em] text-lx-text-success">
                              Synced
                            </span>
                          </div>
                        </div>
                        <p className="text-xs text-lx-text-secondary mt-2 leading-4">
                          Issue created and linked. Column changes now sync with GitHub.
                        </p>
                      </div>
                    ) : (
                      <>
                        {linkState === "idle" && (
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <GithubMark size={14} className="text-lx-text-muted" />
                              <span className="text-sm text-lx-text-muted font-body">No issue linked</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="sync-dot sync-unlinked" />
                              <span className="font-micro text-2xs uppercase tracking-[0.04em] text-lx-text-muted">
                                Unlinked
                              </span>
                            </div>
                          </div>
                        )}
                        {(linkState === "input" || linkState === "loading") && (
                          <div className="flex items-center gap-2">
                            <GithubMark size={14} className="text-lx-text-muted" />
                            <span className="text-sm text-lx-text-muted font-body">GitHub Issues</span>
                          </div>
                        )}
                        {linkState === "input" && (
                          <div className="mt-3">
                            <div className="flex items-center gap-2">
                              <input
                                className="prop-input font-mono flex-1"
                                aria-label="GitHub repository (owner/repo)"
                                placeholder="owner/repo"
                                value={linkRepo}
                                onChange={(e) => setLinkRepo(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" && linkRepo.trim()) {
                                    e.preventDefault();
                                    handleLinkIssue();
                                  }
                                  if (e.key === "Escape") {
                                    e.stopPropagation();
                                    setLinkState("idle");
                                  }
                                }}
                                autoFocus
                              />
                              <button
                                type="button"
                                className="btn btn-primary shrink-0"
                                onClick={handleLinkIssue}
                                disabled={!linkRepo.trim()}
                              >
                                Create issue
                              </button>
                            </div>
                            <p className="text-xs text-lx-text-muted mt-2 leading-4">
                              Creates a GitHub issue from this task and links it.
                            </p>
                          </div>
                        )}
                        {linkState === "loading" && (
                          <div className="mt-3">
                            <div className="flex items-center gap-2">
                              <input
                                className="prop-input font-mono flex-1 opacity-50"
                                aria-label="GitHub repository (owner/repo)"
                                value={linkRepo}
                                disabled
                              />
                              <button type="button" className="btn btn-primary shrink-0 opacity-70" disabled>
                                <span className="spinner" />
                                Creating...
                              </button>
                            </div>
                          </div>
                        )}
                        {linkState === "idle" && (
                          <div className="mt-3">
                            <button type="button" className="btn btn-ghost" onClick={() => setLinkState("input")}>
                              <LinkIcon size={14} />
                              Link issue
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </div>

        <div className="slideover-footer">
          {isCreate ? (
            <>
              <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">Unsaved draft</span>
              <div className="flex items-center gap-2">
                <button type="button" className="btn btn-ghost" onClick={handleClose}>
                  Cancel
                </button>
                <button type="button"
                  className="btn btn-primary"
                  onClick={handleCreate}
                  disabled={!createTitle.trim() || !createColumnId || creating}
                >
                  {creating ? "Creating..." : "Create task"}
                </button>
              </div>
            </>
          ) : (
            <>
              {isArchived ? (
                <button type="button" className="btn btn-ghost" onClick={() => onRestore?.(task!.id)} title="Restore this task to the board">
                  <ArchiveIcon size={14} />
                  Restore
                </button>
              ) : (
                <button type="button" className="btn btn-ghost" onClick={() => onArchive?.(task!.id)} title="Archive this task">
                  <ArchiveIcon size={14} />
                  Archive
                </button>
              )}
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => setShowDeleteDialog(true)}
              >
                <TrashIcon size={14} />
                Delete
              </button>
            </>
          )}
        </div>
      </dialog>

      {showDeleteDialog && task && (
        <>
          <button type="button" className="dialog-overlay" onClick={() => setShowDeleteDialog(false)} aria-label="Close" />
          <div className="fixed inset-0 flex items-center justify-center z-[70] pointer-events-none">
            <dialog open
              className="dialog dialog-enter"
              aria-modal="true"
              aria-labelledby="delete-task-title"
            >
              <div className="flex items-center gap-2">
                <TrashIcon size={18} className="text-lx-text-danger" />
                <h3
                  id="delete-task-title"
                  className="font-display text-lg font-medium text-lx-text-primary"
                >
                  Delete task
                </h3>
              </div>
              <p className="text-sm text-lx-text-secondary mt-3 leading-5">
                Delete <span className="text-lx-text-primary font-medium">&lsquo;{task.title}&rsquo;</span>? This cannot
                be undone.
              </p>
              <div className="flex items-center gap-2 mt-4 justify-end">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setShowDeleteDialog(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-danger-solid"
                  onClick={handleConfirmDelete}
                  disabled={deleting}
                >
                  {deleting ? "Deleting..." : "Delete"}
                </button>
              </div>
            </dialog>
          </div>
        </>
      )}
    </>
  );
}
