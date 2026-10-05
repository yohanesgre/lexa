// Per-document Assistant panel session memory. The popover unmounts on close
// (herald-popover.html: "Closing the popover does NOT stop the run"), so the
// last task id and prompt draft survive here — reopening reattaches to the
// live/final stream state and restores the form instead of starting over.
export interface AssistantPanelSession {
  taskId: string | null;
  prompt: string;
}

const EMPTY: AssistantPanelSession = Object.freeze({ taskId: null, prompt: "" });
const sessions = new Map<string, AssistantPanelSession>();

export function assistantPanelSessionKey(projectSlug: string, documentType: "task" | "wiki", documentId: string): string {
  // Wiki page slugs are only unique per project (docs/SCHEMA.md), so the
  // project must be part of the key or two projects sharing a slug share one
  // bucket (prompt bleed, cross-project task reattach).
  return `${projectSlug}:${documentType}:${documentId}`;
}

export function getAssistantPanelSession(projectSlug: string, documentType: "task" | "wiki", documentId: string): AssistantPanelSession {
  // Create mode has no document yet — never read/write a `"task:"` bucket, so
  // drafts cannot bleed between create flows.
  if (!documentId) return EMPTY;
  return sessions.get(assistantPanelSessionKey(projectSlug, documentType, documentId)) ?? EMPTY;
}

export function patchAssistantPanelSession(
  projectSlug: string,
  documentType: "task" | "wiki",
  documentId: string,
  patch: Partial<AssistantPanelSession>
): void {
  if (!documentId) return;
  const key = assistantPanelSessionKey(projectSlug, documentType, documentId);
  sessions.set(key, { ...(sessions.get(key) ?? EMPTY), ...patch });
}

// Test-only: clear the per-document memory between cases.
export function resetAssistantPanelSessions(): void {
  sessions.clear();
}
