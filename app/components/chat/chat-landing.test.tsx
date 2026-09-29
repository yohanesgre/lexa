// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ChatLanding } from "./ChatLanding";

describe("ChatLanding", () => {
  it("renders the hero glyph, title, scope subline and three starter chips", () => {
    const { container } = render(<ChatLanding onPickStarter={() => {}} />);
    expect(container.querySelector(".chat-landing-hero")).toBeTruthy();
    expect(screen.getByText("What should we get done?")).toBeTruthy();
    expect(screen.getByText("Reads this project's tasks, wiki and activity.")).toBeTruthy();
    expect(container.querySelectorAll(".chat-landing-chip")).toHaveLength(3);
  });

  it("hands the chip's copy to onPickStarter (prefill only, never send)", () => {
    const onPickStarter = vi.fn();
    render(<ChatLanding onPickStarter={onPickStarter} />);
    const chip = screen.getByRole("button", { name: "Find related wiki pages" });
    fireEvent.click(chip);
    expect(onPickStarter).toHaveBeenCalledWith("Find related wiki pages");
  });

  it("renders children (the centered Deck) above the chips", () => {
    const { container } = render(
      <ChatLanding onPickStarter={() => {}}>
        <div className="chat-composer is-landing" />
      </ChatLanding>
    );
    const landing = container.querySelector(".chat-landing")!;
    const compose = landing.querySelector(".chat-composer")!;
    const chips = landing.querySelector(".chat-landing-chips")!;
    expect(compose.compareDocumentPosition(chips) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
