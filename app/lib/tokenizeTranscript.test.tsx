// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { renderTokenized } from "./tokenizeTranscript";

describe("transcript token chips", () => {
  it("renders task keys and wiki slugs as chips linking to board/wiki routes", () => {
    render(
      <div>
        {renderTokenized("Fold @NIM-231 into @payments-migration now", "nimbus")}
      </div>
    );
    const task = screen.getByRole("link", { name: "@NIM-231" });
    expect(task).toHaveAttribute("href", "/nimbus/board?task=NIM-231");
    expect(task.querySelector(".task-key")).not.toBeNull();

    const wiki = screen.getByRole("link", { name: "@payments-migration" });
    expect(wiki).toHaveAttribute("href", "/nimbus/wiki/payments-migration");
  });

  it("leaves non-token text and unknown tokens plain", () => {
    const { container } = render(
      <div>
        {renderTokenized("ping @Maria Kim about @Weird_Ref and @ok-slug", "nimbus")}
      </div>
    );
    // Mixed-case/underscore tokens stay plain text (no links).
    expect(screen.queryByRole("link", { name: "@Maria" })).toBeNull();
    expect(screen.queryByRole("link", { name: "@Weird_Ref" })).toBeNull();
    // Plain prose survives untouched, split across text segments.
    expect(container.textContent).toContain("ping ");
    expect(container.textContent).toContain("@Maria");
    expect(container.textContent).toContain(" Kim about ");
    expect(container.textContent).toContain("@Weird_Ref");
    // Slug-shaped token still becomes a chip.
    expect(screen.getByRole("link", { name: "@ok-slug" })).toHaveAttribute("href", "/nimbus/wiki/ok-slug");
  });
});
