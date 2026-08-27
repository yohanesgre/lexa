// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { MarkdownContent } from "./markdownToReact";

function mount(md: string, opts?: { renderText?: (text: string) => ReactNode; trailing?: ReactNode }) {
  const { container } = render(<MarkdownContent md={md} {...opts} />);
  // MarkdownContent renders a fragment — blocks land as direct children.
  return container;
}

describe("markdownToReact", () => {
  it("bold/emphasis render as elements, not literal asterisks", () => {
    const root = mount("**bold** and *em* text");
    expect(root.querySelector("strong")?.textContent).toBe("bold");
    expect(root.querySelector("em")?.textContent).toBe("em");
    expect(root.textContent).not.toContain("**");
    expect(root.textContent).not.toContain("*em*");
  });

  it("lists: unordered, ordered, nested task checkboxes", () => {
    const ul = mount("- one\n- two");
    expect(ul.querySelectorAll("ul > li")).toHaveLength(2);

    const ol = mount("1. first\n2. second");
    expect(ol.querySelectorAll("ol > li")).toHaveLength(2);

    const tasks = mount("- [ ] open\n- [x] done");
    const boxes = tasks.querySelectorAll('input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).not.toBeChecked();
    expect(boxes[1]).toBeChecked();
  });

  it("list semantics survive: ol/ul elements, item order, nesting, loose items, start attr", () => {
    // Ordered list keeps <ol> + document order of 3+ items.
    const ol = mount("1. alpha\n2. beta\n3. gamma\n4. delta");
    const olEl = ol.querySelector("ol")!;
    expect(olEl).not.toBeNull();
    const items = Array.from(olEl.querySelectorAll(":scope > li"));
    expect(items.map((li) => li.textContent)).toEqual(["alpha", "beta", "gamma", "delta"]);

    // Nested list renders a real ul INSIDE the parent li (not flattened).
    const nested = mount("- outer\n  - inner one\n  - inner two\n- outer two");
    const outerUl = nested.querySelector("ul")!;
    const outerItems = Array.from(outerUl.children).filter((el) => el.tagName === "LI");
    expect(outerItems).toHaveLength(2);
    expect(outerItems[0]!.querySelector("ul > li")).not.toBeNull();
    expect(outerItems[0]!.querySelectorAll("ul > li")).toHaveLength(2);

    // Tight list: bare text in li; loose list: paragraph blocks inside li.
    const tight = mount("- tight");
    expect(tight.querySelector("ul > li p")).toBeNull();
    const loose = mount("- loose item\n\n  with a second paragraph");
    expect(loose.querySelector("ul > li p")).not.toBeNull();

    // Non-1 start number is preserved on the <ol>.
    expect(ol.querySelector("ol")).not.toHaveAttribute("start");
    const shifted = mount("3. three\n4. four");
    expect(shifted.querySelector("ol")).toHaveAttribute("start", "3");
  });

  it("inline code is a chip; fenced code renders pre>code with language stripped", () => {
    const inline = mount("run `npm test` now");
    expect(inline.querySelector("code")?.textContent).toBe("npm test");

    const fenced = mount("```ts\nconst a = 1;\n```");
    const code = fenced.querySelector("pre > code");
    expect(code?.textContent).toBe("const a = 1;");
    expect(fenced.textContent).not.toContain("ts");
  });

  it("fenced code is syntax-highlighted: hljs spans + theme class; unknown lang falls back without crash", () => {
    const js = mount("```js\nconst a = 1;\n```");
    const jsCode = js.querySelector("pre > code.hljs-theme")!;
    expect(jsCode).not.toBeNull();
    expect(jsCode.querySelector(".hljs-keyword")).not.toBeNull();

    const py = mount("```python\nprint('hi')\n```");
    expect(py.querySelector("pre > code .hljs-built_in, pre > code .hljs-string")).not.toBeNull();

    // Unknown language tag → highlightAuto fallback, still themed, no throw.
    const odd = mount("```notalang\nplain words\n```");
    expect(odd.querySelector("pre > code.hljs-theme")).not.toBeNull();
    expect(odd.querySelector("pre > code")?.textContent).toContain("plain words");
  });

  it("links: https allowed with safe attrs; javascript:/relative dropped to plain text", () => {
    const ok = mount("[docs](https://docs.example.com/a)");
    const a = ok.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://docs.example.com/a");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toContain("noopener");
    expect(a.getAttribute("rel")).toContain("noreferrer");

    const evil = mount("[click](javascript:alert(1))");
    expect(evil.querySelector("a")).toBeNull();
    expect(evil.textContent).toContain("click");

    const rel = mount("[x](/api/secret)");
    expect(rel.querySelector("a")).toBeNull();
    expect(rel.textContent).toContain("x");
  });

  it("images never load — alt text stays as plain text", () => {
    const root = mount("before ![alt text](https://img.example/x.png) after");
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain("alt text");
  });

  it("raw HTML tokens are dropped entirely (no injection surface)", () => {
    const root = mount('hello <script>alert(1)</script><img src=x onerror="alert(1)"> world');
    expect(root.querySelector("script")).toBeNull();
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain("hello");
    expect(root.textContent).toContain("world");
  });

  it("headings demote to h1-h4 within the bubble scale", () => {
    const root = mount("# H1\n## H2\n### H3\n#### H4\n##### H5");
    for (const tag of ["h1", "h2", "h3", "h4"]) expect(root.querySelector(tag)).not.toBeNull();
    expect(root.querySelector("h5")).toBeNull();
  });

  it("blockquote and hr render", () => {
    const quoted = mount("> quoted line");
    expect(quoted.querySelector("blockquote")?.textContent).toContain("quoted line");
    const rule = mount("above\n\n---\n\nbelow");
    expect(rule.querySelector("hr")).not.toBeNull();
  });

  it("tables render thead/tbody with header + body cells", () => {
    const root = mount("| A | B |\n|---|---|\n| 1 | 2 |");
    expect(root.querySelector("table")).not.toBeNull();
    expect(root.querySelectorAll("thead th")).toHaveLength(2);
    expect(root.querySelector("thead th")?.textContent).toBe("A");
    expect(root.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(root.querySelectorAll("tbody td")).toHaveLength(2);
    expect(root.querySelector("tbody td")?.textContent).toBe("1");
  });

  it("partial markdown degrades gracefully during streaming", () => {
    const unterminatedBold = mount("working on **some");
    expect(unterminatedBold.querySelector("strong")).toBeNull();
    expect(unterminatedBold.textContent).toContain("**some");

    const unterminatedFence = mount("```js\nstill typing");
    expect(unterminatedFence.querySelector("pre > code")?.textContent).toContain("still typing");
  });

  it("renderText hook decorates plain-text leaves but not code spans", () => {
    const root = mount("plain @LEX-1 and `code @LEX-2`", {
      renderText: (text) => <span data-chip={text.includes("@LEX")} className="chip-wrap">{text}</span>,
    });
    const chips = root.querySelectorAll(".chip-wrap[data-chip='true']");
    expect(chips).toHaveLength(1);
    expect(chips[0]!.textContent).toContain("@LEX-1");
    expect(root.querySelector("code")?.textContent).toBe("code @LEX-2");
    expect(root.querySelector("code .chip-wrap")).toBeNull();
  });

  it("trailing node lands inside the last block element (streaming caret)", () => {
    const el = mount("first para\n\nlast para", { trailing: <span data-caret /> });
    const lastP = el.querySelectorAll("p")[1]!;
    expect(lastP.querySelector("[data-caret]")).not.toBeNull();
  });
});