import { useCallback, useEffect, useRef, useState } from "react";
import type { AssistantStreamStatus } from "../../lib/use-assistant-stream";
import type { ChatAttachmentRef } from "../../lib/assistant-image";

// Client-only queue state (assistant-chat-deck design §3.3). One held message
// per thread; it lives in page memory and is lost on reload. A turn that ends
// cleanly flushes the queue through the normal send path, while a stopped or
// failed turn keeps it held until the user sends it explicitly. The queue is
// text-only: attachments stay in the composer strip until an explicit send.

export type QueuedMessage = {
  text: string;
  heldReason?: "stopped" | "failed";
  flushing?: boolean;
};

export function useChatQueue({ chatId, streamStatus, hasIngress, send, canDispatch = true }: {
  chatId: string;
  streamStatus: AssistantStreamStatus;
  hasIngress: boolean;
  send: (message: string, attachments: ChatAttachmentRef[]) => boolean;
  canDispatch?: boolean;
}) {
  const [byChat, setByChat] = useState<Record<string, QueuedMessage>>({});
  const sendRef = useRef(send);
  sendRef.current = send;

  useEffect(() => {
    const queued = byChat[chatId];
    if (!queued || queued.heldReason) return;
    if (queued.flushing) {
      if (hasIngress) {
        setByChat((prev) => {
          if (prev[chatId] !== queued) return prev;
          const next = { ...prev };
          delete next[chatId];
          return next;
        });
      } else if (streamStatus === "aborted" || streamStatus === "error") {
        setByChat((prev) => prev[chatId] === queued
          ? { ...prev, [chatId]: { ...queued, flushing: false, heldReason: streamStatus === "aborted" ? "stopped" : "failed" } }
          : prev);
      }
      return;
    }
    if (streamStatus === "done") {
      if (!canDispatch) return;
      setByChat((prev) => (prev[chatId] ? { ...prev, [chatId]: { ...queued, flushing: true } } : prev));
      if (sendRef.current(queued.text, []) === false) {
        // Refused flush: never report it as sent — clear flushing and keep the
        // entry so it can still be sent explicitly, cancelled, or edited.
        setByChat((prev) => (prev[chatId] ? { ...prev, [chatId]: { text: queued.text, heldReason: "failed" } } : prev));
      }
    } else if (streamStatus === "aborted" || streamStatus === "error") {
      setByChat((prev) =>
        prev[chatId]
          ? { ...prev, [chatId]: { ...prev[chatId]!, heldReason: streamStatus === "aborted" ? "stopped" : "failed" } }
          : prev
      );
    }
  }, [streamStatus, chatId, byChat, canDispatch, hasIngress]);

  const enqueue = useCallback((text: string): boolean => {
    // One held message per thread: refuse a second rather than silently
    // replace the existing entry — a message the user typed must never be
    // discarded without notice (D8).
    if (byChat[chatId]) return false;
    setByChat((prev) => ({ ...prev, [chatId]: { text } }));
    return true;
  }, [byChat, chatId]);

  const unqueue = useCallback(() => {
    setByChat((prev) => {
      const next = { ...prev };
      delete next[chatId];
      return next;
    });
  }, [chatId]);

  return { queued: byChat[chatId] ?? null, enqueue, unqueue };
}
