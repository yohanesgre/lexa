import { useCallback, useEffect, useState } from "react";
import type { HeadingOutline } from "../components/tiptap-render";
import { hasMatchMedia } from "./viewport";

// The reading line: the section being read is the last heading whose top edge
// has crossed 96px from the viewport top. Document order breaks ties toward the
// deeper heading, the marker is pinned to the first heading while the document
// is at its top (nothing has crossed the line yet) and to the last at its
// bottom, so it never flickers between two entries.
const READING_LINE = 96;

// The document scrolls inside the wiki read area rather than the page, so the
// scrollport is found from the heading itself.
function scrollParentOf(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight + 1) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

export interface ScrollSpy {
  activeId: string;
  scrollTo: (id: string) => void;
}

export function useScrollSpy(headings: HeadingOutline[]): ScrollSpy {
  const [activeId, setActiveId] = useState<string>(() => headings[0]?.id ?? "");

  useEffect(() => {
    if (headings.length === 0) return;
    const first = document.getElementById(headings[0]!.id);
    if (!first) return;

    let frame = 0;
    const update = () => {
      frame = 0;
      const scroller = scrollParentOf(first);
      if (scroller && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1) {
        setActiveId(headings[headings.length - 1]!.id);
        return;
      }
      let active = headings[0]!.id;
      for (const heading of headings) {
        const el = document.getElementById(heading.id);
        if (!el) continue;
        if (el.getBoundingClientRect().top <= READING_LINE) active = heading.id;
        else break;
      }
      setActiveId(active);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };

    update();
    // Scroll events do not bubble, so the listener captures them from any
    // scrollport in the document.
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
    };
  }, [headings]);

  const scrollTo = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    const reduced = hasMatchMedia() && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const behavior: ScrollBehavior = reduced ? "auto" : "smooth";
    const delta = el.getBoundingClientRect().top - READING_LINE;
    const scroller = scrollParentOf(el);
    if (scroller) scroller.scrollBy({ top: delta, behavior });
    else window.scrollBy({ top: delta, behavior });
    setActiveId(id);
    el.focus({ preventScroll: true });
  }, []);

  return { activeId, scrollTo };
}
