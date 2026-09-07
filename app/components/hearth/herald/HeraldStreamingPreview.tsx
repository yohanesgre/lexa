import { useEffect, useRef } from "react";
import { monoBox } from "./herald-panel-utils";

// Live preview: raw markdown deltas appended verbatim into the mono box —
// never rendered rich mid-stream. Auto-scroll pins to the newest line while
// the user hasn't scrolled up; any manual scroll-up pauses follow until
// scrolled back to the bottom.
export function HeraldStreamingPreview({ text }: { text: string }) {
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
