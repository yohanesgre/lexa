import { useCallback, useEffect, useRef, useState } from "react";
import { hasMatchMedia, isNarrowViewport, matchMedia } from "../../lib/viewport";
import type { useHeraldStream } from "../../lib/use-herald-stream";

// Small self-contained hooks for the Herald chat page. The page-level
// stream/turn orchestration stays in HeraldChatPage.

// Sidebar visibility — the collapse control lives INSIDE the sidebar
// (herald-chat.html, mirroring the wiki sidebar): ≥900px it swaps the
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

// Scroll-to-bottom affordance (herald-chat.html): auto-follow keeps the
// view pinned to new deltas while at bottom; scrolling up releases the pin
// until a jump back (button click or manual scroll to bottom).
export function useChatAutoScroll(args: {
  turns: unknown;
  stream: ReturnType<typeof useHeraldStream>;
}) {
  const { turns, stream } = args;
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
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
    if (atBottomRef.current) scrollToBottom(false);
    // stream.items covers tool/reasoning/text item growth — bubble height
    // changes whenever ANY timeline element mounts, not just text deltas.
  }, [turns, stream.text, stream.reasoningText, stream.items, scrollToBottom]);
  return { scrollRef, atBottom, handleTranscriptScroll, scrollToBottom };
}

// Narrow-screen default for the skills panel: collapsed on mobile so the
// tree never starves the content; the choice sticks after first paint.
export function useSkillsPanelDefault() {
  // Narrow screens start collapsed so the tree never starves the content
  // (route is client-only, so reading the viewport at init is safe).
  const [skillsPanelOpen, setSkillsPanelOpen] = useState<boolean>(() => !isNarrowViewport());
  return { skillsPanelOpen, setSkillsPanelOpen };
}
