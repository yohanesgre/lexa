import { useState } from "react";
import { GripVertical, Plus, Trash2, X } from "lucide-react";
import type { Column, Swimlane } from "../../../shared/types";
import {
  useColumns,
  useCreateColumn,
  useUpdateColumn,
  useDeleteColumn,
  useSwimlanes,
  useCreateSwimlane,
  useUpdateSwimlane,
  useDeleteSwimlane,
} from "../../lib/queries";
import { cn } from "../ui/cn";
import { ColumnForm } from "./ColumnForm";
import { SwimlaneForm } from "./SwimlaneForm";

interface KanbanSettingsModalProps {
  slug: string;
  isOpen: boolean;
  onClose: () => void;
}

const formatRequiredFields = (fields: string[]) => (fields.length === 0 ? "—" : fields.join(", "));
const formatWipLimit = (limit: number | null) => (limit === null ? "—" : String(limit).padStart(3, "0"));

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

  const createColumn = useCreateColumn(slug);
  const updateColumn = useUpdateColumn(slug);
  const deleteColumn = useDeleteColumn(slug);

  const createSwimlane = useCreateSwimlane(slug);
  const updateSwimlane = useUpdateSwimlane(slug);
  const deleteSwimlane = useDeleteSwimlane(slug);

  const [columnForm, setColumnForm] = useState<{ isOpen: boolean; column?: Column | null }>({ isOpen: false, column: null });
  const [swimlaneForm, setSwimlaneForm] = useState<{ isOpen: boolean; swimlane?: Swimlane | null }>({ isOpen: false, swimlane: null });

  if (!isOpen) return null;

  const isLoading = columnsLoading || swimlanesLoading;

  return (
    <>
      <div className="dialog-overlay" onClick={onClose} />
      <div className="fixed inset-0 flex items-center justify-center z-[70] pointer-events-none">
        <div
          className="dialog dialog-enter pointer-events-auto p-0"
          style={{ width: 800, maxWidth: "calc(100vw - 48px)" }}
          role="dialog"
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
            {isLoading ? (
              <div className="text-sm text-lx-text-muted py-8 text-center">Loading settings…</div>
            ) : columnsError || swimlanesError ? (
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
                    <div className="bg-lx-surface-card border border-lx-border-default rounded-lg overflow-hidden">
                      <table className="w-full border-collapse text-[13px] font-body">
                        <thead>
                          <tr className="border-b border-lx-border-default">
                            <th className="w-8 py-2.5 px-3"></th>
                            <th className="py-2.5 px-3 text-left text-[11px] uppercase tracking-[0.05em] text-lx-text-secondary font-medium font-body">
                              Name
                            </th>
                            <th className="py-2.5 px-3 text-left text-[11px] uppercase tracking-[0.05em] text-lx-text-secondary font-medium font-body">
                              Color
                            </th>
                            <th className="py-2.5 px-3 text-left text-[11px] uppercase tracking-[0.05em] text-lx-text-secondary font-medium font-body">
                              WIP Limit
                            </th>
                            <th className="py-2.5 px-3 text-left text-[11px] uppercase tracking-[0.05em] text-lx-text-secondary font-medium font-body">
                              Required Fields
                            </th>
                            <th className="py-2.5 px-3 text-left text-[11px] uppercase tracking-[0.05em] text-lx-text-secondary font-medium font-body">
                              GitHub State
                            </th>
                            <th className="w-[100px] py-2.5 px-3"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {columns.map((column) => (
                            <tr key={column.id} className="border-b border-lx-border-default last:border-b-0">
                              <td className="py-2.5 px-3">
                                <GripVertical size={14} className="text-lx-text-muted cursor-grab" />
                              </td>
                              <td className="py-2.5 px-3 text-sm font-medium text-lx-text-primary">{column.name}</td>
                              <td className="py-2.5 px-3">
                                <ColorSwatch color={column.color} />
                              </td>
                              <td className="py-2.5 px-3">
                                <span className="font-mono text-2xs text-lx-text-secondary">{formatWipLimit(column.wipLimit)}</span>
                              </td>
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
                                  <button
                                    type="button"
                                    className="btn btn-ghost h-7 px-2.5 text-xs"
                                    onClick={() => setColumnForm({ isOpen: true, column })}
                                    aria-label="Edit column"
                                  >
                                    Edit
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn-danger h-7 w-7 p-0 flex items-center justify-center"
                                    onClick={() => deleteColumn.mutate({ id: column.id })}
                                    aria-label="Delete column"
                                  >
                                    <Trash2 size={12} strokeWidth={1.5} />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  <button type="button" className="btn btn-ghost mt-3" onClick={() => setColumnForm({ isOpen: true, column: null })}>
                    <Plus size={14} strokeWidth={1.5} />
                    Add Column
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
                    <div className="bg-lx-surface-card border border-lx-border-default rounded-lg overflow-hidden">
                      <table className="w-full border-collapse text-[13px] font-body">
                        <thead>
                          <tr className="border-b border-lx-border-default">
                            <th className="w-8 py-2.5 px-3"></th>
                            <th className="py-2.5 px-3 text-left text-[11px] uppercase tracking-[0.05em] text-lx-text-secondary font-medium font-body">
                              Name
                            </th>
                            <th className="py-2.5 px-3 text-left text-[11px] uppercase tracking-[0.05em] text-lx-text-secondary font-medium font-body">
                              Description
                            </th>
                            <th className="w-[100px] py-2.5 px-3"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {swimlanes.map((swimlane) => (
                            <tr key={swimlane.id} className="border-b border-lx-border-default last:border-b-0">
                              <td className="py-2.5 px-3">
                                <GripVertical size={14} className="text-lx-text-muted cursor-grab" />
                              </td>
                              <td className="py-2.5 px-3 text-sm font-medium text-lx-text-primary">{swimlane.name}</td>
                              <td className="py-2.5 px-3">
                                {swimlane.description ? (
                                  <span className="text-xs text-lx-text-secondary">{swimlane.description}</span>
                                ) : (
                                  <span className="text-xs text-lx-text-muted">—</span>
                                )}
                              </td>
                              <td className="py-2.5 px-3">
                                <div className="flex items-center gap-3">
                                  <button
                                    type="button"
                                    className="btn btn-ghost h-7 px-2.5 text-xs"
                                    onClick={() => setSwimlaneForm({ isOpen: true, swimlane })}
                                    aria-label="Edit swimlane"
                                  >
                                    Edit
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn-danger h-7 w-7 p-0 flex items-center justify-center"
                                    onClick={() => deleteSwimlane.mutate({ id: swimlane.id })}
                                    aria-label="Delete swimlane"
                                  >
                                    <Trash2 size={12} strokeWidth={1.5} />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
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
        </div>
      </div>

      <ColumnForm
        slug={slug}
        column={columnForm.column ?? null}
        isOpen={columnForm.isOpen}
        onClose={() => setColumnForm({ isOpen: false, column: null })}
        onSubmit={(input) => {
          if (columnForm.column) {
            updateColumn.mutate({
              id: columnForm.column.id,
              name: input.name,
              wipLimit: input.wipLimit,
              requiredFields: input.requiredFields,
              color: input.color ?? undefined,
            });
          } else {
            createColumn.mutate({
              name: input.name,
              wipLimit: input.wipLimit,
              requiredFields: input.requiredFields,
              color: input.color ?? undefined,
            });
          }
        }}
      />

      <SwimlaneForm
        slug={slug}
        swimlane={swimlaneForm.swimlane ?? null}
        isOpen={swimlaneForm.isOpen}
        onClose={() => setSwimlaneForm({ isOpen: false, swimlane: null })}
        onSubmit={(input) => {
          if (swimlaneForm.swimlane) {
            updateSwimlane.mutate({ id: swimlaneForm.swimlane.id, name: input.name, description: input.description ?? undefined });
          } else {
            createSwimlane.mutate({ name: input.name, description: input.description ?? undefined });
          }
        }}
      />
    </>
  );
}
