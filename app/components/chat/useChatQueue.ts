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

export function useChatQueue({ chatId, streamStatus, send }: {
  chatId: string;
  streamStatus: AssistantStreamStatus;
  send: (message: string, attachments: ChatAttachmentRef[]) => boolean;
}) {
  const [byChat, setByChat] = useState<Record<string, QueuedMessage>>({});
  const sendRef = useRef(send);
  sendRef.current = send;

  useEffect(() => {
    const queued = byChat[chatId];
    if (!queued || queued.heldReason) return;
    if (queued.flushing) {
      if (streamStatus === "aborted") {
        setByChat((prev) => ({ ...prev, [chatId]: { ...queued, flushing: false, heldReason: "stopped" } }));
      } else if (streamStatus === "error") {
        setByChat((prev) => ({ ...prev, [chatId]: { ...queued, flushing: false, heldReason: "failed" } }));
      } else if (streamStatus !== "done") {
        setByChat((prev) => {
          const next = { ...prev };
          delete next[chatId];
          return next;
        });
      }
      return;
    }
    if (streamStatus === "done") {
      // A flush already refused for this entry pins `flushing` to false: retrying
      // it under the same `done` would re-send a message the page keeps refusing
      // and spin the effect. It stays held for edit / cancel / explicit send.
      if (queued.flushing === false) return;
      setByChat((prev) => (prev[chatId] ? { ...prev, [chatId]: { ...queued, flushing: true } } : prev));
      if (sendRef.current(queued.text, []) === false) {
        // Refused flush: never report it as sent — clear flushing and keep the
        // entry so it can still be sent explicitly, cancelled, or edited.
        setByChat((prev) => (prev[chatId] ? { ...prev, [chatId]: { ...queued, flushing: false } } : prev));
      }
    } else if (streamStatus === "aborted" || streamStatus === "error") {
      setByChat((prev) =>
        prev[chatId]
          ? { ...prev, [chatId]: { ...prev[chatId]!, heldReason: streamStatus === "aborted" ? "stopped" : "failed" } }
          : prev
      );
    }
  }, [streamStatus, chatId, byChat]);

  const enqueue = useCallback((text: string) => {
    setByChat((prev) => ({ ...prev, [chatId]: { text } }));
  }, [chatId]);

  const unqueue = useCallback(() => {
    setByChat((prev) => {
      const next = { ...prev };
      delete next[chatId];
      return next;
    });
  }, [chatId]);

  return { queued: byChat[chatId] ?? null, enqueue, unqueue };
}
