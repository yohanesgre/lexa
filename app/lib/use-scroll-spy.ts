import { useCallback, useEffect, useState } from "react";
import type { HeadingOutline } from "../components/tiptap-render";
import { hasMatchMedia } from "./viewport";

function prefersReducedMotion(): boolean {
  return hasMatchMedia() && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export interface ScrollSpy {
  activeId: string;
  scrollTo: (id: string) => void;
}

export function useScrollSpy(headings: HeadingOutline[]): ScrollSpy {
  const [activeId, setActiveId] = useState<string>(() => headings[0]?.id ?? "");

  useEffect(() => {
    if (headings.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
          }
        }
      },
      { rootMargin: "-80px 0px -70% 0px", threshold: 0 }
    );

    const observed = new Set<string>();
    for (const h of headings) {
      const el = document.getElementById(h.id);
      if (el && !observed.has(h.id)) {
        observer.observe(el);
        observed.add(h.id);
      }
    }

    return () => observer.disconnect();
  }, [headings]);

  const scrollTo = useCallback((id: string) => {
    setActiveId(id);
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, []);

  return { activeId, scrollTo };
}
