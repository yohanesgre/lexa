const KEY_PREFIX = "lexa:board-milestone:";

function getStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    // Storage can throw when cookies/private mode block it.
    return null;
  }
}

export function readBoardMilestone(slug: string): string | null {
  const storage = getStorage();
  if (!storage) return null;
  try {
    return storage.getItem(KEY_PREFIX + slug);
  } catch {
    return null;
  }
}

export function writeBoardMilestone(slug: string, value: string): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(KEY_PREFIX + slug, value);
  } catch {
    // Ignore write failures; the URL param still drives this render.
  }
}
