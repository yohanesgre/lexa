// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { renderTokenized, tokenizeMentionText } from "./tokenizeTranscript";

describe("tokenizeMentionText", () => {
  it("classifies task keys, slug tokens, skill tokens and prose", () => {
    expect(tokenizeMentionText("@NIM-231 @in-review $Status @Maria")).toEqual([
      { kind: "task", text: "@NIM-231", ref: "NIM-231" },
      { kind: "text", text: " " },
      { kind: "wiki", text: "@in-review", ref: "in-review" },
      { kind: "text", text: " " },
      { kind: "skill", text: "$Status", ref: "Status" },
      { kind: "text", text: " " },
      { kind: "text", text: "@Maria" },
    ]);
  });
});

describe("renderTokenized — transcript chips", () => {
  it("links an unambiguous task key to the board deep-link", () => {
    const { container } = render(<div>{renderTokenized("see @NIM-231 now", "nimbus")}</div>);
    const link = container.querySelector("a.mention-chip");
    expect(link).toHaveAttribute("href", "/nimbus/board?task=NIM-231");
    expect(link!.querySelector(".task-key")?.textContent).toBe("@NIM-231");
  });

  it("renders a slug-shaped @token as a plain chip — never a dead wiki link", () => {
    const { container } = render(<div>{renderTokenized("ask @in-review please", "nimbus")}</div>);
    expect(container.querySelector("a")).toBeNull();
    const chip = container.querySelector("span.mention-chip");
    expect(chip).toBeTruthy();
    expect(chip!.textContent).toBe("@in-review");
    expect(container.innerHTML).not.toContain("/wiki/");
  });

  it("keeps a member-name token as plain text", () => {
    const { container } = render(<div>{renderTokenized("hi @Maria", "nimbus")}</div>);
    expect(container.querySelector(".mention-chip")).toBeNull();
    expect(container.textContent).toBe("hi @Maria");
  });

  it("renders $name as a non-link skill chip", () => {
    const { container } = render(<div>{renderTokenized("use $Status", "nimbus")}</div>);
    const chip = container.querySelector(".mention-chip-skill");
    expect(chip).toBeTruthy();
    expect(chip!.textContent).toBe("$Status");
    expect(container.querySelector("a")).toBeNull();
  });
});
