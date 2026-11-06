// SSR-environment stand-ins for @dnd-kit (wired through the SSR-guarded
// `resolveId` hook in vite.config.ts). Drag-and-drop only exists in the browser;
// the Workers server bundle links kanban/settings routes but never renders
// them. Exports are inert so a module-scope touch cannot throw.
export const DndContext = (): null => null;
export const SortableContext = (): null => null;
export const DragOverlay = (): null => null;

export class PointerSensor {}

export const useSensor = (): Record<string, never> => ({});
export const useSensors = (...sensors: unknown[]): unknown[] => sensors;
export const useDroppable = (): { setNodeRef: () => void; isOver: boolean } => ({
  setNodeRef: () => undefined,
  isOver: false,
});
export const useSortable = () => ({
  attributes: {},
  listeners: {},
  setNodeRef: () => undefined,
  setActivatorNodeRef: () => undefined,
  transform: null,
  transition: undefined,
  isDragging: false,
});
export const verticalListSortingStrategy = (): null => null;

export function arrayMove<T>(array: T[], from: number, to: number): T[] {
  const next = array.slice();
  next.splice(to < 0 ? next.length + to : to, 0, next.splice(from, 1)[0]!);
  return next;
}

export const CSS = {
  Transform: { toString: (): undefined => undefined },
  Translate: { toString: (): undefined => undefined },
};
