export function parseDateOnly(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function formatDueLabel(dueAt: string, today = new Date()): { text: string; overdue: boolean } {
  const due = parseDateOnly(dueAt);
  const now = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const days = Math.round((due.getTime() - now.getTime()) / 86400000);
  if (days < 0) return { text: `Overdue ${-days}d`, overdue: true };
  if (days === 0) return { text: "Due today", overdue: false };
  const weekday = due.toLocaleDateString("en-US", { weekday: "short" });
  return { text: days === 1 ? `Due ${weekday}` : `Due ${weekday} · ${days}d left`, overdue: false };
}
