// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { HeraldActivity } from "./HeraldActivity";
import type { HeraldTimelineItem, HeraldToolChip } from "../../lib/use-herald-stream";

const toolChip = (key: string, phase: "call" | "result"): HeraldToolChip => ({
  key,
  name: key,
  label: key === "search" ? "Searching web…" : key,
  phase,
});

const text = (t: string): HeraldTimelineItem => ({ kind: "text", text: t });
const reasoning = (t: string, ms: number | null = null): HeraldTimelineItem => ({ kind: "reasoning", text: t, ms });
const toolItem = (key: string, phase: "call" | "result"): HeraldTimelineItem => ({ kind: "tool", chip: toolChip(key, phase) });

describe("HeraldActivity timeline", () => {
  it("streaming with no frames yet: lone caret keeps the bubble alive", () => {
    const { container } = render(<HeraldActivity items={[]} tools={[]} reasoningActive={false} reasoningMs={null} />);
    expect(container.querySelector(".bubble-md .herald-stream-caret")).not.toBeNull();
  });
  it("done with no summary parts renders nothing (no stray caret)", () => {
    const { container } = render(<HeraldActivity items={[]} tools={[]} reasoningActive={false} reasoningMs={null} done />);
    expect(container).toBeEmptyDOMElement();
  });
});
