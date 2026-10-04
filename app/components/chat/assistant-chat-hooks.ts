import { useCallback, useEffect, useRef, useState } from "react";
import { hasMatchMedia, matchMedia } from "../../lib/viewport";
import { lastApprovalBatch, type ChatTurn } from "./assistant-chat-utils";
import type { useAssistantStream } from "../../lib/use-assistant-stream";

// Small self-contained hooks for the Assistant chat page. The page-level
// stream/turn orchestration stays in AssistantChatPage.

// Sidebar visibility — the collapse control lives INSIDE the sidebar
// (assistant-chat.html, mirroring the wiki sidebar): ≥900px it swaps the
// docked column for a 36px restore rail, <900px the rail button opens the
// overlay drawer. The collapsed choice persists globally in localStorage
// lexa-chat-sidebar ("0" = collapsed); hydrated client-side (SSR-safe —
// no window access during render).
export function useChatSidebar() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  useEffect(() => {
    try {
      if (window.localStorage.getItem("lexa-chat-sidebar") === "0") setSidebarOpen(false);
      // On mobile the overlay would obscure the chat — default to closed
      // unless the user explicitly opened it on this device.
      else if (matchMedia("(max-width: 899.98px)") && window.localStorage.getItem("lexa-chat-sidebar") !== "1") {
        setSidebarOpen(false);
      }
    } catch {
      // non-fatal
    }
  }, []);
  const toggleSidebar = useCallback(() => {
    const next = !sidebarOpen;
    setSidebarOpen(next);
    try {
      window.localStorage.setItem("lexa-chat-sidebar", next ? "1" : "0");
    } catch {
      // non-fatal
    }
  }, [sidebarOpen]);
  // The top nav's "PanelLeft" button dispatches this event on mobile.
  // We toggle the threads sidebar. Desktop behavior is unchanged (the
  // collapsed rail remains the entry point there).
  useEffect(() => {
    function handleToggle() {
      if (hasMatchMedia() && matchMedia("(max-width: 899.98px)")) {
        setSidebarOpen((v) => !v);
      }
    }
    window.addEventListener("lexa:toggle-threads-sidebar", handleToggle);
    return () => window.removeEventListener("lexa:toggle-threads-sidebar", handleToggle);
  }, []);
  return { sidebarOpen, setSidebarOpen, toggleSidebar };
}

// Floating-composer clearance (assistant-chat.html): the docked composer is
// pinned over the transcript, so the app measures its height and writes
// --chat-composer-clearance (measured height + the 48px scrim lead) onto the
// .chat-shell containing block. 140px stays the CSS fallback floor while the
// composer is unmeasurable (SSR / no ResizeObserver).
export function useChatComposerClearance() {
  const composerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    const shell = el.closest<HTMLElement>(".chat-shell");
    if (!shell) return;
    const apply = () => {
      const height = el.getBoundingClientRect().height;
      if (height <= 0) return;
      shell.style.setProperty("--chat-composer-clearance", `${Math.round(height) + 48}px`);
    };
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => {
      observer.disconnect();
      shell.style.removeProperty("--chat-composer-clearance");
    };
  }, []);
  return composerRef;
}

// Scroll-to-bottom affordance (assistant-chat.html): auto-follow keeps the
// view pinned to new deltas while at bottom; scrolling up releases the pin
// until a jump back (button click or manual scroll to bottom).
export function useChatAutoScroll(args: {
  turns: ChatTurn[] | null;
  stream: ReturnType<typeof useAssistantStream>;
  chatId: string;
}) {
  const { turns, stream, chatId } = args;
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  // Whether the newest turn carried a still-pending batch on the previous
  // render. The pending → all-terminal flip is the resume moment: the arrival
  // scroll landed the batch header at the scroller top and released the
  // at-bottom pin, so the normal follow gate would strand the view at the
  // batch top and the continuation would never be followed.
  const prevNewestPendingRef = useRef(false);
  // Thread switch: the prior thread's scroll position and pending-flip latch
  // must not carry into the incoming thread's transcript.
  useEffect(() => {
    atBottomRef.current = true;
    prevNewestPendingRef.current = false;
    setAtBottom(true);
  }, [chatId]);
  const handleTranscriptScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    atBottomRef.current = near;
    setAtBottom(near);
  }, []);
  const scrollToBottom = useCallback((smooth: boolean) => {
    const el = scrollRef.current;
    if (!el) return;
    if (typeof el.scrollTo === "function") {
      el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, []);
  useEffect(() => {
    const root = scrollRef.current;
    const newest = turns && turns.length > 0 ? turns[turns.length - 1] : undefined;
    const newestPending = newest?.batch?.chips.some((chip) => chip.state === "pending") === true;
    // Resume moment (herald-write-approvals.html): the newest batch flipped
    // from pending to all-terminal. The arrival scroll released the at-bottom
    // pin, so scroll the continuation into view once — checked BEFORE the
    // atBottomRef gate, otherwise the released pin would suppress it. The ref
    // update makes it fire exactly once per transition.
    if (!newestPending && prevNewestPendingRef.current) {
      prevNewestPendingRef.current = false;
      scrollToBottom(false);
      return;
    }
    prevNewestPendingRef.current = newestPending;
    if (!atBottomRef.current) return;
    // Proposal arrival (herald-write-approvals.html): when the newest turn
    // carries a still-pending batch, land the batch header at the scroller's
    // top (below the header scrim via `scroll-padding-top`) instead of pinning
    // to the bottom — the bulk actions must be reachable at rest. No pending
    // batch → follow the stream to the bottom as before.
    if (root && newestPending) {
      lastApprovalBatch(root)?.scrollIntoView({
        block: "start",
        behavior: matchMedia("(prefers-reduced-motion: reduce)") ? "auto" : "smooth",
      });
      return;
    }
    scrollToBottom(false);
    // stream.items covers tool/reasoning/text item growth — bubble height
    // changes whenever ANY timeline element mounts, not just text deltas.
  }, [turns, stream.text, stream.reasoningText, stream.items, scrollToBottom]);
  return { scrollRef, atBottom, handleTranscriptScroll, scrollToBottom };
}
