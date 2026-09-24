export const activeChats = new Map<string, AbortController>();

export function tryAcquireChat(chatId: string): boolean {
  if (activeChats.has(chatId)) return false;
  activeChats.set(chatId, new AbortController());
  return true;
}

export function releaseChat(chatId: string, controller?: AbortController): void {
  if (controller !== undefined) {
    if (activeChats.get(chatId) === controller) activeChats.delete(chatId);
    return;
  }
  activeChats.delete(chatId);
}
