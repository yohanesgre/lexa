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

function SortableRow({ id, children, className }: { id: string; children: React.ReactNode; className?: string }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  return (
    <tr ref={setNodeRef} style={style} className={className} {...attributes}>
      <td className="py-2.5 px-3" {...listeners} style={{ cursor: "grab" }}>
        <GripVertical size={14} className="text-lx-text-muted" />
      </td>
      {children}
    </tr>
  );
}

function ColorSwatch({ color }: { color: string }) {
  if (!color) {
    return (
      <span className="inline-flex items-center gap-2">
        <span className="color-swatch" style={{ background: "transparent", borderColor: "var(--lx-border-strong)" }} />
        <span className="text-xs text-lx-text-muted">None</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2">
      <span className="color-swatch" style={{ background: color }} />
      <span className="text-xs text-lx-text-secondary">{colorName(color)}</span>
    </span>
  );
}

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

function EmptySection({ type, onAdd }: { type: "column" | "swimlane"; onAdd: () => void }) {
  const isColumn = type === "column";
  return (
    <div className="bg-lx-surface-card border border-dashed border-lx-border-strong rounded-lg p-8 flex flex-col items-center gap-1.5 text-center">
      <div className="empty-state-icon">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
          {isColumn ? (
            <>
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M9 4v16M15 4v16" />
            </>
          ) : (
            <>
              <path d="M3 6h18M3 12h18M3 18h18" />
            </>
          )}
        </svg>
      </div>
      <div className="empty-state-title">No {type}s yet</div>
      <div className="empty-state-desc">
        {isColumn ? "Add a column to start tracking tasks." : "Add a swimlane to group related work horizontally."}
      </div>
      <button type="button" className="btn btn-primary mt-2" onClick={onAdd}>
        <Plus size={14} strokeWidth={1.5} />
        Add {isColumn ? "Column" : "Swimlane"}
      </button>
    </div>
  );
}

export function KanbanSettingsModal({ slug, isOpen, onClose }: KanbanSettingsModalProps) {
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

  if (!isOpen) return null;

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
          <div className="flex items-center justify-between h-14 px-4 border-b border-lx-border-subtle flex-shrink-0">
            <h2 id="board-settings-title" className="font-display text-base font-medium text-lx-text-primary">
              Board Settings
            </h2>
            <button type="button" className="btn btn-ghost w-8 h-8 p-0" onClick={onClose} aria-label="Close">
              <X size={18} strokeWidth={1.5} />
            </button>
          </div>

          <div className="px-5 py-4 overflow-y-auto" style={{ maxHeight: "calc(100vh - 140px)" }}>
            {isLoading || configLoading ? (
              <div className="text-sm text-lx-text-muted py-8 text-center">Loading settings…</div>
            ) : columnsError || swimlanesError || configError ? (
              <div className="text-sm text-lx-text-danger py-8 text-center">Failed to load settings.</div>
            ) : (
              <>
                <section className="mb-8">
                  <h3 className="font-display text-base font-medium text-lx-text-primary mb-3">Columns</h3>
                  <p className="text-sm text-lx-text-secondary mb-3 max-w-[560px]">
                    Define board columns, WIP limits, required fields per column, and GitHub state mapping.
                  </p>

                  {columns.length === 0 ? (
                    <EmptySection type="column" onAdd={() => setColumnForm({ isOpen: true, column: null })} />
                  ) : (
                    <div className="bg-lx-surface-card border border-lx-border rounded-lg overflow-hidden">
                      <DndContext sensors={sensors} onDragEnd={handleColumnDragEnd}>
                        <SortableContext items={orderedColumns.map((c) => c.id)} strategy={verticalListSortingStrategy}>
                      <table className="w-full border-collapse text-[13px] font-body">
                        <thead>
                          <tr className="border-b border-lx-border">
                            <th className="w-8 py-2.5 px-3"></th>
                            <th className="py-2.5 px-3 text-left text-[11px] uppercase tracking-[0.05em] text-lx-text-secondary font-medium font-body">Name</th>
                            <th className="py-2.5 px-3 text-left text-[11px] uppercase tracking-[0.05em] text-lx-text-secondary font-medium font-body">Color</th>
                            <th className="py-2.5 px-3 text-left text-[11px] uppercase tracking-[0.05em] text-lx-text-secondary font-medium font-body">WIP Limit</th>
                            <th className="py-2.5 px-3 text-left text-[11px] uppercase tracking-[0.05em] text-lx-text-secondary font-medium font-body">Required Fields</th>
                            <th className="py-2.5 px-3 text-left text-[11px] uppercase tracking-[0.05em] text-lx-text-secondary font-medium font-body">GitHub State</th>
                            <th className="w-[100px] py-2.5 px-3"></th>
                          </tr>
                        </thead>
                        <tbody>
                              {orderedColumns.map((column) => (
                                <SortableRow key={column.id} id={column.id} className="border-b border-lx-border last:border-b-0">
                                  <td className="py-2.5 px-3 text-sm font-medium text-lx-text-primary">{column.name}</td>
                                  <td className="py-2.5 px-3"><ColorSwatch color={column.color} /></td>
                                  <td className="py-2.5 px-3"><span className="font-mono text-2xs text-lx-text-secondary">{formatWipLimit(column.wipLimit)}</span></td>
                                  <td className="py-2.5 px-3">
                                    <span className={cn("text-xs", column.requiredFields.length === 0 ? "text-lx-text-muted" : "text-lx-text-secondary")}>
                                      {formatRequiredFields(column.requiredFields)}
                                    </span>
                                  </td>
                                  <td className="py-2.5 px-3">
                                    {column.githubState ? (
                                      <span className="font-mono text-2xs text-lx-text-success">{column.githubState}</span>
                                    ) : (
                                      <span className="text-xs text-lx-text-muted">—</span>
                                    )}
                                  </td>
                                  <td className="py-2.5 px-3">
                                    <div className="flex items-center gap-3">
                                      <button type="button" className="btn btn-ghost h-7 px-2.5 text-xs" onClick={() => setColumnForm({ isOpen: true, column })} aria-label="Edit column">Edit</button>
                                      <button type="button" className="btn btn-danger h-7 w-7 p-0 flex items-center justify-center" onClick={() => setDeleteColumnTarget(column)} aria-label="Delete column">
                                        <Trash2 size={12} strokeWidth={1.5} />
                                      </button>
                                    </div>
                                  </td>
                                </SortableRow>
                              ))}
                        </tbody>
                      </table>
                        </SortableContext>
                      </DndContext>
                    </div>
                  )}

                  <button type="button" className="btn btn-ghost mt-3" onClick={() => setColumnForm({ isOpen: true, column: null })}>
                    <Plus size={14} strokeWidth={1.5} />
                    Add Column
                  </button>
                </section>

                <section className="mb-8">
                  <h3 className="font-display text-base font-medium text-lx-text-primary mb-3">Priorities</h3>
                  <p className="text-sm text-lx-text-secondary mb-3 max-w-[560px]">
                    The priority options available on tasks in this project. First option is the create default.
                  </p>
                  {orderedOptions.priorities.length === 0 ? (
                    <div className="text-sm text-lx-text-muted py-4">No priorities configured.</div>
                  ) : (
                    <div className="bg-lx-surface-card border border-lx-border rounded-lg overflow-hidden">
                      <DndContext sensors={sensors} onDragEnd={(e) => handleOptionDragEnd(e, "priority")}>
                        <SortableContext items={orderedOptions.priorities.map((o) => o.id)} strategy={verticalListSortingStrategy}>
                          <table className="w-full border-collapse text-[13px] font-body">
                            <thead>
                              <tr className="border-b border-lx-border">
                                <th className="w-8 py-2.5 px-3"></th>
                                <th className="py-2.5 px-3 text-left text-[11px] uppercase tracking-[0.05em] text-lx-text-secondary font-medium font-body">Label</th>
                                <th className="py-2.5 px-3 text-left text-[11px] uppercase tracking-[0.05em] text-lx-text-secondary font-medium font-body">Color</th>
                                <th className="w-[100px] py-2.5 px-3"></th>
                              </tr>
                            </thead>
                            <tbody>
                              {orderedOptions.priorities.map((opt) => (
                                <SortableRow key={opt.id} id={opt.id} className="border-b border-lx-border last:border-b-0">
                                  <td className="py-2.5 px-3 text-sm font-medium text-lx-text-primary">{opt.label}</td>
                                  <td className="py-2.5 px-3">
                                    <span className="inline-flex items-center gap-2">
                                      <span className="color-swatch" style={{ background: opt.color }} />
                                      <span className="text-xs text-lx-text-secondary">{opt.color}</span>
                                    </span>
                                  </td>
                                  <td className="py-2.5 px-3">
                                    <div className="flex items-center gap-3">
                                      <button type="button" className="btn btn-ghost h-7 px-2.5 text-xs" onClick={() => setOptionForm({ kind: "priority", isOpen: true, option: opt })} aria-label="Edit priority">Edit</button>
                                      <button type="button" className="btn btn-danger h-7 w-7 p-0 flex items-center justify-center" onClick={() => deleteOption("priority", opt)} aria-label="Delete priority">
                                        <Trash2 size={12} strokeWidth={1.5} />
                                      </button>
                                    </div>
                                  </td>
                                </SortableRow>
                              ))}
                            </tbody>
                          </table>
                        </SortableContext>
                      </DndContext>
                    </div>
                  )}
                  <button type="button" className="btn btn-ghost mt-3" onClick={() => setOptionForm({ kind: "priority", isOpen: true, option: null })}>
                    <Plus size={14} strokeWidth={1.5} />
                    Add Priority
                  </button>
                </section>

                <section className="mb-8">
                  <h3 className="font-display text-base font-medium text-lx-text-primary mb-3">Types</h3>
                  <p className="text-sm text-lx-text-secondary mb-3 max-w-[560px]">
                    The type options available on tasks in this project. First option is the create default.
                  </p>
                  {orderedOptions.types.length === 0 ? (
                    <div className="text-sm text-lx-text-muted py-4">No types configured.</div>
                  ) : (
                    <div className="bg-lx-surface-card border border-lx-border rounded-lg overflow-hidden">
                      <DndContext sensors={sensors} onDragEnd={(e) => handleOptionDragEnd(e, "type")}>
                        <SortableContext items={orderedOptions.types.map((o) => o.id)} strategy={verticalListSortingStrategy}>
                          <table className="w-full border-collapse text-[13px] font-body">
                            <thead>
                              <tr className="border-b border-lx-border">
                                <th className="w-8 py-2.5 px-3"></th>
                                <th className="py-2.5 px-3 text-left text-[11px] uppercase tracking-[0.05em] text-lx-text-secondary font-medium font-body">Label</th>
                                <th className="py-2.5 px-3 text-left text-[11px] uppercase tracking-[0.05em] text-lx-text-secondary font-medium font-body">Color</th>
                                <th className="w-[100px] py-2.5 px-3"></th>
                              </tr>
                            </thead>
                            <tbody>
                              {orderedOptions.types.map((opt) => (
                                <SortableRow key={opt.id} id={opt.id} className="border-b border-lx-border last:border-b-0">
                                  <td className="py-2.5 px-3 text-sm font-medium text-lx-text-primary">{opt.label}</td>
                                  <td className="py-2.5 px-3">
                                    <span className="inline-flex items-center gap-2">
                                      <span className="color-swatch" style={{ background: opt.color }} />
                                      <span className="text-xs text-lx-text-secondary">{opt.color}</span>
                                    </span>
                                  </td>
                                  <td className="py-2.5 px-3">
                                    <div className="flex items-center gap-3">
                                      <button type="button" className="btn btn-ghost h-7 px-2.5 text-xs" onClick={() => setOptionForm({ kind: "type", isOpen: true, option: opt })} aria-label="Edit type">Edit</button>
                                      <button type="button" className="btn btn-danger h-7 w-7 p-0 flex items-center justify-center" onClick={() => deleteOption("type", opt)} aria-label="Delete type">
                                        <Trash2 size={12} strokeWidth={1.5} />
                                      </button>
                                    </div>
                                  </td>
                                </SortableRow>
                              ))}
                            </tbody>
                          </table>
                        </SortableContext>
                      </DndContext>
                    </div>
                  )}
                  <button type="button" className="btn btn-ghost mt-3" onClick={() => setOptionForm({ kind: "type", isOpen: true, option: null })}>
                    <Plus size={14} strokeWidth={1.5} />
                    Add Type
                  </button>
                </section>

                <section>
                  <h3 className="font-display text-base font-medium text-lx-text-primary mb-3">Swimlanes</h3>
                  <p className="text-sm text-lx-text-secondary mb-3 max-w-[560px]">
                    Group related work horizontally on the board. Swimlanes are optional.
                  </p>

                  {swimlanes.length === 0 ? (
                    <EmptySection type="swimlane" onAdd={() => setSwimlaneForm({ isOpen: true, swimlane: null })} />
                  ) : (
                    <div className="bg-lx-surface-card border border-lx-border rounded-lg overflow-hidden">
                      <DndContext sensors={sensors} onDragEnd={handleSwimlaneDragEnd}>
                        <SortableContext items={orderedSwimlanes.map((s) => s.id)} strategy={verticalListSortingStrategy}>
                      <table className="w-full border-collapse text-[13px] font-body">
                        <thead>
                          <tr className="border-b border-lx-border">
                            <th className="w-8 py-2.5 px-3"></th>
                            <th className="py-2.5 px-3 text-left text-[11px] uppercase tracking-[0.05em] text-lx-text-secondary font-medium font-body" style={{ width: 160 }}>Name</th>
                            <th className="py-2.5 px-3 text-left text-[11px] uppercase tracking-[0.05em] text-lx-text-secondary font-medium font-body">Description</th>
                            <th className="w-[100px] py-2.5 px-3"></th>
                          </tr>
                        </thead>
                        <tbody>
                              {orderedSwimlanes.map((swimlane) => (
                                <SortableRow key={swimlane.id} id={swimlane.id} className="border-b border-lx-border last:border-b-0">
                                  <td className="py-2.5 px-3 text-sm font-medium text-lx-text-primary">{swimlane.name}</td>
                                  <td className="py-2.5 px-3" style={{ maxWidth: 0 }}>
                                    {swimlane.description ? (
                                      <button
                                        type="button"
                                        className="text-xs text-lx-text-secondary truncate block cursor-pointer"
                                        style={{ border: "none", background: "none", padding: 0, maxWidth: "100%" }}
                                        title={swimlane.description}
                                        onClick={() => setDescModalTarget(swimlane)}
                                      >
                                        {swimlane.description}
                                      </button>
                                    ) : (
                                      <span className="text-xs text-lx-text-muted">—</span>
                                    )}
                                  </td>
                                  <td className="py-2.5 px-3">
                                    <div className="flex items-center gap-3">
                                      <button type="button" className="btn btn-ghost h-7 px-2.5 text-xs" onClick={() => setSwimlaneForm({ isOpen: true, swimlane })} aria-label="Edit swimlane">Edit</button>
                                      <button type="button" className="btn btn-danger h-7 w-7 p-0 flex items-center justify-center" onClick={() => setDeleteSwimlaneTarget(swimlane)} aria-label="Delete swimlane">
                                        <Trash2 size={12} strokeWidth={1.5} />
                                      </button>
                                    </div>
                                  </td>
                                </SortableRow>
                              ))}
                        </tbody>
                      </table>
                        </SortableContext>
                      </DndContext>
                    </div>
                  )}

                  <button type="button" className="btn btn-ghost mt-3" onClick={() => setSwimlaneForm({ isOpen: true, swimlane: null })}>
                    <Plus size={14} strokeWidth={1.5} />
                    Add Swimlane
                  </button>
                </section>
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
            });
          } else {
            createColumn.mutate({
              name: input.name,
              wipLimit: input.wipLimit,
              requiredFields: input.requiredFields,
              color: input.color ?? undefined,
              githubState: (input.githubState as "open" | "closed" | null | undefined) ?? undefined,
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
            updateSwimlane.mutate({ id: swimlaneForm.swimlane.id, name: input.name, description: input.description ?? undefined });
          } else {
            createSwimlane.mutate({ name: input.name, description: input.description ?? undefined });
          }
        }}
      />
      )}

      {deleteColumnTarget &&
        <ModalPortal overlayZ={80} dialogZ={81}>
          <dialog open className="dialog dialog-enter pointer-events-auto" aria-modal="true" aria-label="Confirm">
            <h2 className="font-display text-lg font-medium text-lx-text-primary">Delete &lsquo;{deleteColumnTarget.name}&rsquo;?</h2>
            <p className="text-sm text-lx-text-secondary mt-3 leading-5">
              This will remove all tasks in this column. This action cannot be undone.
            </p>
            <div className="flex items-center gap-2 mt-4 justify-end">
              <button type="button" className="btn btn-ghost" onClick={() => setDeleteColumnTarget(null)}>Cancel</button>
              <button type="button" className="btn btn-danger-solid" onClick={() => { deleteColumn.mutate({ id: deleteColumnTarget.id }); setDeleteColumnTarget(null); }}>
                <Trash2 size={14} strokeWidth={1.5} />
                Delete
              </button>
            </div>
          </dialog>
        </ModalPortal>}

      {deleteSwimlaneTarget &&
        <ModalPortal overlayZ={80} dialogZ={81}>
          <dialog open className="dialog dialog-enter pointer-events-auto" aria-modal="true" aria-label="Confirm">
            <h2 className="font-display text-lg font-medium text-lx-text-primary">Delete &lsquo;{deleteSwimlaneTarget.name}&rsquo;?</h2>
            <p className="text-sm text-lx-text-secondary mt-3 leading-5">
              This will unassign all tasks in this swimlane. This action cannot be undone.
            </p>
            <div className="flex items-center gap-2 mt-4 justify-end">
              <button type="button" className="btn btn-ghost" onClick={() => setDeleteSwimlaneTarget(null)}>Cancel</button>
              <button type="button" className="btn btn-danger-solid" onClick={() => { deleteSwimlane.mutate({ id: deleteSwimlaneTarget.id }); setDeleteSwimlaneTarget(null); }}>
                <Trash2 size={14} strokeWidth={1.5} />
                Delete
              </button>
            </div>
          </dialog>
        </ModalPortal>}

      {descModalTarget &&
        <ModalPortal overlayZ={80} dialogZ={81}>
          <dialog open className="dialog dialog-enter pointer-events-auto" aria-modal="true" aria-label="Confirm" style={{ maxWidth: 440 }}>
            <h2 className="font-display text-lg font-medium text-lx-text-primary">{descModalTarget.name}</h2>
            <div className="text-sm text-lx-text-secondary font-body leading-5 mt-3 whitespace-pre-wrap">
              {descModalTarget.description || "No description."}
            </div>
            <div className="flex items-center justify-end gap-2 mt-4">
              <button type="button" className="btn btn-ghost" onClick={() => setDescModalTarget(null)}>Close</button>
            </div>
          </dialog>
        </ModalPortal>}

      {descModalTarget &&
        <ModalPortal overlayZ={base.overlayZ} dialogZ={base.dialogZ}>
          <dialog open className="dialog dialog-enter pointer-events-auto" aria-modal="true" aria-label="Confirm" style={{ maxWidth: 440 }}>
            <h2 className="font-display text-lg font-medium text-lx-text-primary">{descModalTarget.name}</h2>
            <div className="text-sm text-lx-text-secondary font-body leading-5 mt-3 whitespace-pre-wrap">
              {descModalTarget.description || "No description."}
            </div>
            <div className="flex items-center justify-end gap-2 mt-4">
              <button type="button" className="btn btn-ghost" onClick={() => setDescModalTarget(null)}>Close</button>
            </div>
          </dialog>
        </ModalPortal>}
    </>
  );
}
