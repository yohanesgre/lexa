import React, { useState, useEffect, useMemo } from "react";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Plus, Trash2, X } from "lucide-react";
import { ColumnsSettingsSection } from "./ColumnsSettingsSection";
import { OptionSettingsSection } from "./OptionSettingsSection";
import { SwimlanesSettingsSection } from "./SwimlanesSettingsSection";
import { ModalPortal, useModalStack } from "../ui/ModalStack";
import type { Column, Swimlane, FieldConfig, FieldOption } from "../../../shared/types";
import {
  useColumns,
  useCreateColumn,
  useUpdateColumn,
  useDeleteColumn,
  useSwimlanes,
  useCreateSwimlane,
  useUpdateSwimlane,
  useDeleteSwimlane,
  useFieldConfig,
  useUpdateFieldConfig,
} from "../../lib/queries";
import { cn } from "../ui/cn";
import { ColumnForm } from "./ColumnForm";
import { SwimlaneForm } from "./SwimlaneForm";
import { OptionForm } from "./OptionForm";

interface KanbanSettingsModalProps {
  slug: string;
  isOpen: boolean;
  onClose: () => void;
}

const formatRequiredFields = (fields: string[]) => (fields.length === 0 ? "—" : fields.join(", "));
const formatWipLimit = (limit: number | null) => (limit === null ? "—" : String(limit).padStart(3, "0"));



function colorName(color: string): string {
  const names: Record<string, string> = {
    "#6B7280": "Gray",
    "#3B82F6": "Blue",
    "#F0C040": "Amber",
    "#F59E0B": "Amber",
    "#4ADE80": "Green",
    "#10B981": "Green",
    "#22D3EE": "Cyan",
    "#FF4444": "Red",
    "#EF4444": "Red",
    "#F472B6": "Pink",
    "#A855F7": "Purple",
  };
  return names[color.toUpperCase()] ?? color;
}



function ConfirmDeleteDialog({ title, body, onCancel, onConfirm }: { title: string; body: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <ModalPortal overlayZ={80} dialogZ={81}>
      <dialog open className="dialog dialog-enter pointer-events-auto" aria-modal="true" aria-label="Confirm">
        <h2 className="font-display text-lg font-medium text-lx-text-primary">{title}</h2>
        <p className="text-sm text-lx-text-secondary mt-3 leading-5">{body}</p>
        <div className="flex items-center gap-2 mt-4 justify-end">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn btn-danger-solid" onClick={onConfirm}>
            <Trash2 size={14} strokeWidth={1.5} />
            Delete
          </button>
        </div>
      </dialog>
    </ModalPortal>
  );
}

function DescriptionModal({ target, onClose, overlayZ, dialogZ }: { target: Swimlane; onClose: () => void; overlayZ: number; dialogZ: number }) {
  return (
    <ModalPortal overlayZ={overlayZ} dialogZ={dialogZ}>
      <dialog open className="dialog dialog-enter pointer-events-auto" aria-modal="true" aria-label="Confirm" style={{ maxWidth: 440 }}>
        <h2 className="font-display text-lg font-medium text-lx-text-primary">{target.name}</h2>
        <div className="text-sm text-lx-text-secondary font-body leading-5 mt-3 whitespace-pre-wrap">
          {target.description || "No description."}
        </div>
        <div className="flex items-center justify-end gap-2 mt-4">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </dialog>
    </ModalPortal>
  );
}

function SettingsModalHeader({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex items-center justify-between h-14 px-4 border-b border-lx-border-subtle flex-shrink-0">
      <h2 id="board-settings-title" className="font-display text-base font-medium text-lx-text-primary">
        Board Settings
      </h2>
      <button type="button" className="btn btn-ghost w-8 h-8 p-0" onClick={onClose} aria-label="Close">
        <X size={18} strokeWidth={1.5} />
      </button>
    </div>
  );
}

export function KanbanSettingsModal({ slug, isOpen, onClose }: KanbanSettingsModalProps) {
  // The outer component must NOT hold any data hooks: it renders null when
  // closed, so the board never fetches columns/swimlanes/field-config until
  // the modal actually opens. All hooks live in SettingsContent, which only
  // mounts once isOpen is true.
  if (!isOpen) return null;
  return <SettingsContent slug={slug} onClose={onClose} />;
}

function SettingsContent({ slug, onClose }: { slug: string; onClose: () => void }) {
  const { data: columns = [], isLoading: columnsLoading, isError: columnsError } = useColumns(slug);
  const { data: swimlanes = [], isLoading: swimlanesLoading, isError: swimlanesError } = useSwimlanes(slug);
  const { data: fieldConfig, isLoading: configLoading, isError: configError } = useFieldConfig(slug);
  const updateFieldConfig = useUpdateFieldConfig(slug);
  const base = useModalStack();

  const createColumn = useCreateColumn(slug);
  const updateColumn = useUpdateColumn(slug);
  const deleteColumn = useDeleteColumn(slug);

  const createSwimlane = useCreateSwimlane(slug);
  const updateSwimlane = useUpdateSwimlane(slug);
  const deleteSwimlane = useDeleteSwimlane(slug);

  const [optionForm, setOptionForm] = useState<{ kind: "priority" | "type"; isOpen: boolean; option?: FieldOption | null }>({ kind: "priority", isOpen: false, option: null });
  const [optionOrder, setOptionOrder] = useState<{ priorities: string[]; types: string[] }>({ priorities: [], types: [] });

  useEffect(() => {
    if (fieldConfig) setOptionOrder({ priorities: fieldConfig.priorities.map((o) => o.id), types: fieldConfig.types.map((o) => o.id) });
  }, [fieldConfig]);

  const orderedOptions = useMemo(() => {
    if (!fieldConfig) return { priorities: [] as FieldOption[], types: [] as FieldOption[] };
    const order = (list: FieldOption[], ids: string[]) => {
      if (ids.length === 0) return list;
      return ids.flatMap((id) => { const o = list.find((x) => x.id === id); return o ? [o] : []; });
    };
    return { priorities: order(fieldConfig.priorities, optionOrder.priorities), types: order(fieldConfig.types, optionOrder.types) };
  }, [fieldConfig, optionOrder]);

  const handleOptionDragEnd = (event: DragEndEvent, kind: "priority" | "type") => {
    const ids = kind === "priority" ? optionOrder.priorities : optionOrder.types;
    const oldIndex = ids.indexOf(event.active.id as string);
    const newIndex = ids.indexOf(event.over!.id as string);
    if (oldIndex === newIndex || !fieldConfig) return;
    const reordered = arrayMove(ids, oldIndex, newIndex);
    setOptionOrder((prev) => ({ ...prev, [kind]: reordered }));
    const full = {
      priorities: kind === "priority"
        ? reordered.map((id) => {
            const o = fieldConfig.priorities.find((x) => x.id === id)!;
            return { id: o.id, label: o.label, color: o.color };
          })
        : fieldConfig.priorities.map((o) => ({ id: o.id, label: o.label, color: o.color })),
      types: kind === "type"
        ? reordered.map((id) => {
            const o = fieldConfig.types.find((x) => x.id === id)!;
            return { id: o.id, label: o.label, color: o.color };
          })
        : fieldConfig.types.map((o) => ({ id: o.id, label: o.label, color: o.color })),
    };
    updateFieldConfig.mutate(full);
  };

  const submitOption = (input: { label: string; color: string }) => {
    if (!fieldConfig) return;
    const { kind } = optionForm;
    const list = kind === "priority" ? fieldConfig.priorities : fieldConfig.types;
    const existing = optionForm.option;
    const next = existing
      ? list.map((o) => (o.id === existing.id ? { ...o, label: input.label, color: input.color } : o))
      : [...list, { id: "", label: input.label, color: input.color, position: list.length }];
    const full = kind === "priority"
      ? { priorities: next.map((o) => ({ id: o.id, label: o.label, color: o.color })), types: fieldConfig.types.map((o) => ({ id: o.id, label: o.label, color: o.color })) }
      : { priorities: fieldConfig.priorities.map((o) => ({ id: o.id, label: o.label, color: o.color })), types: next.map((o) => ({ id: o.id, label: o.label, color: o.color })) };
    updateFieldConfig.mutate(full, {
      onError: () => {
        // Revert optimistic order on failure.
        if (fieldConfig) setOptionOrder({ priorities: fieldConfig.priorities.map((o) => o.id), types: fieldConfig.types.map((o) => o.id) });
      },
    });
  };

  const deleteOption = (kind: "priority" | "type", option: FieldOption) => {
    if (!fieldConfig) return;
    const list = kind === "priority" ? fieldConfig.priorities : fieldConfig.types;
    const next = list.filter((o) => o.id !== option.id);
    const full = kind === "priority"
      ? { priorities: next.map((o) => ({ id: o.id, label: o.label, color: o.color })), types: fieldConfig.types.map((o) => ({ id: o.id, label: o.label, color: o.color })) }
      : { priorities: fieldConfig.priorities.map((o) => ({ id: o.id, label: o.label, color: o.color })), types: next.map((o) => ({ id: o.id, label: o.label, color: o.color })) };
    updateFieldConfig.mutate(full);
  };

  const [columnForm, setColumnForm] = useState<{ isOpen: boolean; column?: Column | null }>({ isOpen: false, column: null });
  const [swimlaneForm, setSwimlaneForm] = useState<{ isOpen: boolean; swimlane?: Swimlane | null }>({ isOpen: false, swimlane: null });
  const [deleteColumnTarget, setDeleteColumnTarget] = useState<Column | null>(null);
  const [deleteSwimlaneTarget, setDeleteSwimlaneTarget] = useState<Swimlane | null>(null);
  const [descModalTarget, setDescModalTarget] = useState<Swimlane | null>(null);

  // DnD state — track local item order, sync positions on drop
  const [colOrder, setColOrder] = useState<string[]>([]);
  const [laneOrder, setLaneOrder] = useState<string[]>([]);

  useEffect(() => {
    if (columns.length > 0) setColOrder(columns.map((c) => c.id));
  }, [columns]);

  useEffect(() => {
    if (swimlanes.length > 0) setLaneOrder(swimlanes.map((s) => s.id));
  }, [swimlanes]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleColumnDragEnd = (event: DragEndEvent) => {
    const oldIndex = colOrder.indexOf(event.active.id as string);
    const newIndex = colOrder.indexOf(event.over!.id as string);
    if (oldIndex === newIndex) return;
    const reordered = arrayMove(colOrder, oldIndex, newIndex);
    setColOrder(reordered);
    reordered.forEach((id, i) => {
      updateColumn.mutate({ id, position: i });
    });
  };

  const handleSwimlaneDragEnd = (event: DragEndEvent) => {
    const oldIndex = laneOrder.indexOf(event.active.id as string);
    const newIndex = laneOrder.indexOf(event.over!.id as string);
    if (oldIndex === newIndex) return;
    const reordered = arrayMove(laneOrder, oldIndex, newIndex);
    setLaneOrder(reordered);
    reordered.forEach((id, i) => {
      updateSwimlane.mutate({ id, position: i });
    });
  };

  const orderedColumns = useMemo(() => {
    if (colOrder.length === 0) return columns;
    return colOrder.flatMap((id) => { const c = columns.find((c) => c.id === id); return c ? [c] : []; });
  }, [columns, colOrder]);

  const orderedSwimlanes = useMemo(() => {
    if (laneOrder.length === 0) return swimlanes;
    return laneOrder.flatMap((id) => { const s = swimlanes.find((s) => s.id === id); return s ? [s] : []; });
  }, [swimlanes, laneOrder]);

  const isLoading = columnsLoading || swimlanesLoading;

  return (
    <>
      <button
        type="button"
        className="dialog-overlay"
        aria-label="Close dialog"
        onClick={onClose}
        />
      <div className="fixed inset-0 flex items-center justify-center z-[70] pointer-events-none">
        <dialog open
          className="dialog dialog-enter pointer-events-auto p-0"
          style={{ width: 800, maxWidth: "calc(100vw - 48px)" }}
          aria-modal="true"
          aria-labelledby="board-settings-title"
        >
          <SettingsModalHeader onClose={onClose} />

          <div className="px-5 py-4 overflow-y-auto" style={{ maxHeight: "calc(100vh - 140px)" }}>
            {isLoading || configLoading ? (
              <div className="text-sm text-lx-text-muted py-8 text-center">Loading settings…</div>
            ) : columnsError || swimlanesError || configError ? (
              <div className="text-sm text-lx-text-danger py-8 text-center">Failed to load settings.</div>
            ) : (
              <>
                <ColumnsSettingsSection
                  columns={orderedColumns}
                  sensors={sensors}
                  onDragEnd={handleColumnDragEnd}
                  onEdit={(col) => setColumnForm({ isOpen: true, column: col })}
                  onDelete={setDeleteColumnTarget}
                  onAdd={() => setColumnForm({ isOpen: true, column: null })}
                />


                <OptionSettingsSection
                  kind="priority"
                  title="Priorities"
                  description="The priority options available on tasks in this project. First option is the create default."
                  options={orderedOptions.priorities}
                  sensors={sensors}
                  onDragEnd={(e) => handleOptionDragEnd(e, "priority")}
                  onEdit={(opt) => setOptionForm({ kind: "priority", isOpen: true, option: opt })}
                  onDelete={(opt) => deleteOption("priority", opt)}
                  onAdd={() => setOptionForm({ kind: "priority", isOpen: true, option: null })}
                />


                <OptionSettingsSection
                  kind="type"
                  title="Types"
                  description="The type options available on tasks in this project. First option is the create default."
                  options={orderedOptions.types}
                  sensors={sensors}
                  onDragEnd={(e) => handleOptionDragEnd(e, "type")}
                  onEdit={(opt) => setOptionForm({ kind: "type", isOpen: true, option: opt })}
                  onDelete={(opt) => deleteOption("type", opt)}
                  onAdd={() => setOptionForm({ kind: "type", isOpen: true, option: null })}
                />


                <SwimlanesSettingsSection
                  swimlanes={orderedSwimlanes}
                  sensors={sensors}
                  onDragEnd={handleSwimlaneDragEnd}
                  onEdit={(sw) => setSwimlaneForm({ isOpen: true, swimlane: sw })}
                  onDelete={setDeleteSwimlaneTarget}
                  onAdd={() => setSwimlaneForm({ isOpen: true, swimlane: null })}
                  onShowDescription={setDescModalTarget}
                />

              </>
            )}
          </div>
        </dialog>
      </div>

      {optionForm.isOpen && (
<OptionForm
        kind={optionForm.kind}
        option={optionForm.option ?? null}
        isOpen={optionForm.isOpen}
        zIndex={90}
        onClose={() => setOptionForm({ ...optionForm, isOpen: false })}
        onSubmit={submitOption}
      />
      )}

      {columnForm.isOpen && (
<ColumnForm
        slug={slug}
        column={columnForm.column ?? null}
        isOpen={columnForm.isOpen}
        zIndex={80}
        onClose={() => setColumnForm({ isOpen: false, column: null })}
        onSubmit={(input) => {
          if (columnForm.column) {
            updateColumn.mutate({
              id: columnForm.column.id,
              name: input.name,
              wipLimit: input.wipLimit,
              requiredFields: input.requiredFields,
              color: input.color ?? undefined,
              githubState: (input.githubState as "open" | "closed" | null | undefined) ?? undefined,
              isDone: input.isDone ?? false,
            });
          } else {
            createColumn.mutate({
              name: input.name,
              wipLimit: input.wipLimit,
              requiredFields: input.requiredFields,
              color: input.color ?? undefined,
              githubState: (input.githubState as "open" | "closed" | null | undefined) ?? undefined,
              isDone: input.isDone ?? false,
            });
          }
        }}
      />
      )}

      {swimlaneForm.isOpen && (
<SwimlaneForm
        slug={slug}
        swimlane={swimlaneForm.swimlane ?? null}
        isOpen={swimlaneForm.isOpen}
        zIndex={80}
        onClose={() => setSwimlaneForm({ isOpen: false, swimlane: null })}
        onSubmit={(input) => {
          if (swimlaneForm.swimlane) {
            updateSwimlane.mutate({ id: swimlaneForm.swimlane.id, name: input.name, description: input.description ?? undefined, dueAt: input.dueAt ?? undefined, startAt: input.startAt ?? undefined, milestoneId: input.milestoneId ?? undefined });
          } else {
            createSwimlane.mutate({ name: input.name, description: input.description ?? undefined, dueAt: input.dueAt ?? undefined, startAt: input.startAt ?? undefined, milestoneId: input.milestoneId ?? undefined });
          }
        }}
      />
      )}

      {deleteColumnTarget && (
        <ConfirmDeleteDialog
          title={`Delete ‘${deleteColumnTarget.name}’?`}
          body="This will remove all tasks in this column. This action cannot be undone."
          onCancel={() => setDeleteColumnTarget(null)}
          onConfirm={() => { deleteColumn.mutate({ id: deleteColumnTarget.id }); setDeleteColumnTarget(null); }}
        />
      )}

      {deleteSwimlaneTarget && (
        <ConfirmDeleteDialog
          title={`Delete ‘${deleteSwimlaneTarget.name}’?`}
          body="This will unassign all tasks in this swimlane. This action cannot be undone."
          onCancel={() => setDeleteSwimlaneTarget(null)}
          onConfirm={() => { deleteSwimlane.mutate({ id: deleteSwimlaneTarget.id }); setDeleteSwimlaneTarget(null); }}
        />
      )}

      

      {descModalTarget && (
        <DescriptionModal target={descModalTarget} onClose={() => setDescModalTarget(null)} overlayZ={base.overlayZ} dialogZ={base.dialogZ} />
      )}
    </>
  );
}
