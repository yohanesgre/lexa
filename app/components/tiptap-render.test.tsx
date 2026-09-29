// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { TipTapDoc } from "../../shared/types";
import { renderDoc, renderMention, SHARE_OUTSIDE_SUBTREE, type ShareRenderContext } from "./tiptap-render";

const ATTACHMENT_ID = "11111111-1111-1111-1111-111111111111";

function docWithLink(href: string): TipTapDoc {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "target", marks: [{ type: "link", attrs: { href } }] }],
      },
    ],
  };
}

function autoDoc(href: string): TipTapDoc {
  return {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "target", marks: [{ type: "link", attrs: { href } }] }] },
      { type: "image", attrs: { src: `/api/attachments/${ATTACHMENT_ID}`, alt: "shot" } },
    ],
  };
}

const share: ShareRenderContext = {
  token: "tok",
  pageIds: new Map([["child", "w2"]]),
};

function renderShare(doc: TipTapDoc, context: ShareRenderContext = share) {
  return render(<div>{renderDoc(doc, "wiki", undefined, context)}</div>);
}

describe("renderDoc share path", () => {
  it("keeps the app path unchanged: relative internal links stay plain text, images unchanged", () => {
    const { container } = render(<div>{renderDoc(autoDoc("/demo/wiki/child"), "wiki", "demo")}</div>);
    expect(screen.queryByRole("link", { name: "target" })).toBeNull();
    expect(container.querySelector("img")).toHaveAttribute("src", `/api/attachments/${ATTACHMENT_ID}`);
  });

  it("rewrites attachment images to the share attachment endpoint", () => {
    const { container } = renderShare(autoDoc("/demo/wiki/child"));
    expect(container.querySelector("img")).toHaveAttribute("src", `/api/share/tok/attachments/${ATTACHMENT_ID}`);
  });

  it("resolves internal links inside the subtree to the shared page", () => {
    renderShare(docWithLink("/demo/wiki/child"));
    expect(screen.getByRole("link", { name: "target" })).toHaveAttribute("href", "/share/tok?page=w2");
  });

  it("resolves internal links that leave the subtree to Variant B, never into the app", () => {
    renderShare(docWithLink("/demo/wiki/other"));
    expect(screen.getByRole("link", { name: "target" })).toHaveAttribute(
      "href",
      `/share/tok?page=${SHARE_OUTSIDE_SUBTREE}`
    );
  });

  it("resolves non-wiki app links to Variant B as well", () => {
    renderShare(docWithLink("/demo/board?task=t1"));
    expect(screen.getByRole("link", { name: "target" })).toHaveAttribute(
      "href",
      `/share/tok?page=${SHARE_OUTSIDE_SUBTREE}`
    );
  });

  it("leaves external links untouched", () => {
    renderShare(docWithLink("https://example.com/docs"));
    expect(screen.getByRole("link", { name: "target" })).toHaveAttribute("href", "https://example.com/docs");
  });

  it("leaves an existing share link untouched", () => {
    renderShare(docWithLink("/share/tok?page=w2"));
    expect(screen.getByRole("link", { name: "target" })).toHaveAttribute("href", "/share/tok?page=w2");
  });
});

function renderMentionChip(refType: string, refId: string, label: string, slug?: string) {
  return render(<div>{renderMention({ refType, refId, label }, "k", slug, "task")}</div>);
}

describe("renderMention — mention chips", () => {
  it("links a task mention to the board deep-link", () => {
    const { container } = renderMentionChip("task", "t1", "EG-1", "demo");
    const link = container.querySelector("a.mention-chip");
    expect(link).toHaveAttribute("href", "/demo/board?task=t1");
    expect(link!.querySelector(".task-key")?.textContent).toBe("@EG-1");
  });

  it("links a wiki mention to the wiki page", () => {
    const { container } = renderMentionChip("wiki", "home", "Home", "demo");
    expect(container.querySelector("a.mention-chip")).toHaveAttribute("href", "/demo/wiki/home");
  });

  it("renders entity refTypes as plain chips with no link", () => {
    for (const refType of ["milestone", "swimlane", "column"]) {
      const { container, unmount } = renderMentionChip(refType, "m1", "Q3 Launch", "demo");
      expect(container.querySelector("a")).toBeNull();
      const chip = container.querySelector("span.mention-chip");
      expect(chip).toBeTruthy();
      expect(chip!.textContent).toBe("@Q3 Launch");
      unmount();
    }
  });

  it("renders a chip with no link when there is no project context", () => {
    const { container } = renderMentionChip("task", "t1", "EG-1");
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("span.mention-chip")).toBeTruthy();
  });
});
