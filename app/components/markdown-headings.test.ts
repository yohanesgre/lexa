import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { markdownToReact, planHeadings, slugifyHeading } from "../lib/markdownToReact";

describe("Markdown heading anchors", () => {
  it("keeps a heading that repeats the reserved page title addressable", () => {
    const titleId = slugifyHeading("Release Checklist");
    const plan = planHeadings("# Release Checklist\n\n## Rollback", [titleId]);
    expect([titleId, ...plan.headings.map((heading) => heading.id)]).toEqual(["release-checklist", "release-checklist-2", "rollback"]);
  });

  it("gives duplicate headings stable unique suffixes", () => {
    const plan = planHeadings("## Retro\n\n## Retro\n\n## Retro");
    expect(plan.headings.map((heading) => heading.id)).toEqual(["retro", "retro-2", "retro-3"]);
  });

  it("keeps rendered heading IDs aligned with a reused outline plan", () => {
    const source = "## Installation\n\n## Verification\n\n## Rollback";
    const plan = planHeadings(source, [slugifyHeading("Release")]);
    const headingIds = plan.createHeadingIds();
    const render = () =>
      renderToStaticMarkup(
        createElement(
          Fragment,
          null,
          markdownToReact(source, { surface: "document", headingIds })
        )
      );

    const firstRender = render();
    const repeatedRender = render();
    const renderedIds = Array.from(firstRender.matchAll(/<h[1-4][^>]* id="([^"]+)"/g), (match) => match[1]);
    const outlineIds = plan.headings.map((heading) => heading.id);

    expect(renderedIds).toEqual(outlineIds);
    expect(repeatedRender).toBe(firstRender);
    expect(outlineIds.every((id) => firstRender.includes(`id="${id}"`))).toBe(true);
  });
});
