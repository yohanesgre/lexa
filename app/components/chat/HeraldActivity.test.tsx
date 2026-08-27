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

  it("chronological order: text → tool → text renders as three interleaved blocks in arrival order", () => {
    const { container } = render(
      <HeraldActivity
        items={[text("first burst"), toolItem("fetch", "call"), text("second burst")]}
        tools={[toolChip("fetch", "call")]}
        reasoningActive={false}
        reasoningMs={null}
      />
    );
    const children = Array.from(container.children);
    expect(children).toHaveLength(3);
    // bubble-md → activity strip → bubble-md, in that DOM order.
    expect(children[0]).toHaveClass("bubble-md");
    expect(children[1]).toHaveClass("herald-activity");
    expect(children[2]).toHaveClass("bubble-md");
    expect(children[0]!.textContent).toContain("first burst");
    expect(children[1]!.textContent).toContain("[fetch]");
    expect(children[2]!.textContent).toContain("second burst");
  });

  it("stream caret rides only the LAST text item; earlier bursts stay caret-free", () => {
    const { container } = render(
      <HeraldActivity
        items={[text("earlier"), toolItem("fetch", "call"), text("live")]}
        tools={[]}
        reasoningActive={false}
        reasoningMs={null}
      />
    );
    const mds = container.querySelectorAll(".bubble-md");
    expect(mds).toHaveLength(2);
    expect(mds[0]!.querySelector(".herald-stream-caret")).toBeNull();
    expect(mds[1]!.querySelector(".herald-stream-caret")).not.toBeNull();
  });

  it("streaming never folds: consecutive same-name calls each render as their own expanded line", () => {
    const { container } = render(
      <HeraldActivity
        items={[toolItem("search", "result"), toolItem("search", "result"), toolItem("search", "call")]}
        tools={[]}
        reasoningActive={false}
        reasoningMs={null}
      />
    );
    expect(container.querySelectorAll(".herald-activity-tool")).toHaveLength(3);
    expect(screen.getAllByText("[search]")).toHaveLength(3);
    expect(container.querySelector(".herald-activity-caret")).not.toBeNull();
  });

  it("active reasoning row: 'Thinking…' auto-expanded; closed rows show their own 'Thought for Ns'", () => {
    const { container } = render(
      <HeraldActivity
        items={[reasoning("burst one", 4000), text("mid answer"), reasoning("burst two live")]}
        tools={[]}
        reasoningActive={true}
        reasoningMs={4000}
      />
    );
    const toggles = screen.getAllByRole("button");
    expect(toggles).toHaveLength(2);
    expect(toggles[0]).toHaveTextContent(/thought for 4s/i);
    expect(toggles[0]).toHaveAttribute("aria-expanded", "false");
    expect(toggles[1]).toHaveTextContent(/thinking…/i);
    expect(toggles[1]).toHaveAttribute("aria-expanded", "true");
    // Only the ACTIVE burst's body is visible.
    expect(container.textContent).toContain("burst two live");
    expect(container.textContent).not.toContain("burst one");
  });

  it("done: process output hoists into ONE summary-toggled block ABOVE the reply; reply stays outside and clean", () => {
    const chips = [toolChip("search", "result"), toolChip("read", "result"), toolChip("fetch", "result")];
    const items: HeraldTimelineItem[] = [
      reasoning("hidden thoughts", null),
      { kind: "tool", chip: chips[0]! },
      text("the clean reply"),
      { kind: "tool", chip: chips[1]! },
      { kind: "tool", chip: chips[2]! },
    ];
    const { container } = render(
      <HeraldActivity items={items} tools={chips} reasoningActive={false} reasoningMs={6400} done />
    );

    // Collapsed: only the summary line; no reply text inside the block.
    const summary = screen.getByRole("button", { name: /thought for 6s · 3 tools/i });
    expect(summary).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelectorAll(".herald-activity-tool")).toHaveLength(0);
    expect(container.querySelector(".herald-activity")!.textContent).not.toContain("the clean reply");

    // Expanded: reasoning + every call line, in arrival order, plain per-call rows.
    fireEvent.click(summary);
    expect(summary).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("hidden thoughts")).toBeInTheDocument();
    expect(container.querySelectorAll(".herald-activity-tool.done")).toHaveLength(3);
    const html = container.innerHTML;
    expect(html.indexOf("hidden thoughts")).toBeLessThan(html.indexOf("[search]"));
    expect(html.indexOf("[search]")).toBeLessThan(html.indexOf("[read]"));
    expect(html.indexOf("[read]")).toBeLessThan(html.indexOf("[fetch]"));

    // Re-collapse.
    fireEvent.click(summary);
    expect(container.querySelectorAll(".herald-activity-tool")).toHaveLength(0);
  });

  it("summary drops zero parts; sub-second durations read '<1s'", () => {
    const { rerender, container } = render(
      <HeraldActivity items={[toolItem("search", "result")]} tools={[toolChip("search", "result")]} reasoningActive={false} reasoningMs={null} done />
    );
    expect(screen.getByRole("button", { name: /^1 tool$/i })).toBeInTheDocument();

    rerender(<HeraldActivity items={[reasoning("brief", 300)]} tools={[]} reasoningActive={false} reasoningMs={300} done />);
    expect(screen.getByRole("button", { name: /thought for <1s/i })).toBeInTheDocument();
    expect(container.querySelectorAll(".herald-activity-tool")).toHaveLength(0);
  });
});
