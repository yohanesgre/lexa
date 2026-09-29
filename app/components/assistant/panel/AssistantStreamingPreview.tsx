import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";

function monoBox(maxHeight: number): CSSProperties {
  return {
    background: "var(--lx-surface-input)",
    border: "1px solid var(--lx-border-default)",
    borderRadius: 6,
    padding: "10px 12px",
    fontFamily: "var(--lx-font-mono)",
    fontSize: 11,
    lineHeight: "18px",
    color: "var(--lx-text-secondary)",
    maxHeight,
    overflowY: "auto",
    whiteSpace: "pre-wrap",
  };
}

// Live preview: raw markdown deltas appended verbatim into the mono box —
// never rendered rich mid-stream. Auto-scroll pins to the newest line while
// the user hasn't scrolled up; any manual scroll-up pauses follow until
// scrolled back to the bottom.
export function AssistantStreamingPreview({ text }: { text: string }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  useEffect(() => {
    const el = bodyRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <div style={{ padding: "10px 12px" }}>
      <span className="prop-label" style={{ display: "block", marginBottom: 6 }}>
        Preview <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]" style={{ marginLeft: 4 }}>raw markdown</span>
      </span>
      <div
        ref={bodyRef}
        role="log"
        aria-live="polite"
        onScroll={(e) => {
          const el = e.currentTarget;
          followRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
        }}
        style={monoBox(180)}
      >
        {text}
        <span style={{ animation: "lx-wip-pulse 1.2s ease-in-out infinite", color: "var(--lx-border-focus)" }}>▍</span>
      </div>
    </div>
  );
}
