export function clampLimit(n: number | string | null | undefined): number {
  const parsed = typeof n === "string" ? parseInt(n, 10) : (n ?? 50);
  if (isNaN(parsed) || parsed < 1) return 50;
  if (parsed > 200) return 200;
  return parsed;
}

export function encodeCursor(columnId: string, position: string, taskId: string): string {
  return btoa(`${columnId}:${position}:${taskId}`);
}

export function decodeCursor(cursor: string | null): { columnId: string; position: string; taskId: string } | null {
  if (!cursor) return null;
  try {
    const decoded = atob(cursor);
    const [columnId, position, taskId] = decoded.split(":");
    if (!columnId || !position || !taskId) return null;
    return { columnId, position, taskId };
  } catch {
    return null;
  }
}

export function nextCursor(tasks: Array<{ columnId: string; position: string; id: string }>, limit: number): string | null {
  if (tasks.length < limit) return null;
  const last = tasks[tasks.length - 1];
  return encodeCursor(last.columnId, last.position, last.id);
}
