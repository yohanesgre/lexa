import { Children, cloneElement, isValidElement, memo, useMemo, useRef, type ReactNode } from "react";
import { marked, type Token, type Tokens } from "marked";
import hljs from "highlight.js/lib/common";
import { withKeys } from "./withKeys";

// Assistant-transcript markdown → React elements. LLM output is UNTRUSTED,
// so this never touches dangerouslySetInnerHTML EXCEPT for highlighted code:
// hljs escapes its output by design and we escape the fallback path too
// (highlightBoundary note below). Links allow http(s) only
// (javascript:/data:/relative hrefs degrade to plain text) and open in a new
// tab; images never load — they collapse to their alt text; raw HTML tokens
// are dropped entirely. Partial markdown degrades gracefully: an unterminated
// `**` pair or ``` fence just renders as text/code until closed.

export interface MarkdownRenderOptions {
  // Hook for plain-text leaves (e.g. mention-chip tokenization). Never
  // applied inside code spans/blocks — those keep literal semantics.
  renderText?: ((text: string) => ReactNode) | undefined;
}

// Highlighted-code boundary: the ONLY dangerouslySetInnerHTML in chat. Input
// is untrusted; output is hljs's escaped HTML, or our own escaped fallback
// when hljs throws or the grammar is unknown.
export function highlightCode(code: string, lang?: string): string {
  try {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
    return hljs.highlightAuto(code).value;
  } catch {
    return code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
}

function safeHref(href: unknown): string | null {
  if (typeof href !== "string") return null;
  return /^https?:\/\//i.test(href) ? href : null;
}

const BLOCK_TAGS = new Set(["p", "h1", "h2", "h3", "h4"]);

function renderInline(tokens: Token[] | undefined, opts: MarkdownRenderOptions): ReactNode[] {
  return withKeys(tokens ?? [], (t) => t.type).map(({ item: t, key: k }) => {
    switch (t.type) {
      case "text":
        return (
          <span key={k}>
            {"tokens" in t && t.tokens ? renderInline(t.tokens, opts) : (opts.renderText ? opts.renderText((t as Tokens.Text).text) : (t as Tokens.Text).text)}
          </span>
        );
      case "escape":
        return <span key={k}>{(t as Tokens.Escape).text}</span>;
      case "strong":
        return <strong key={k}>{renderInline((t as Tokens.Strong).tokens, opts)}</strong>;
      case "em":
        return <em key={k}>{renderInline((t as Tokens.Em).tokens, opts)}</em>;
      case "del":
        return <del key={k}>{(t as Tokens.Del).text}</del>;
      case "codespan":
        return <code key={k}>{(t as Tokens.Codespan).text}</code>;
      case "link": {
        const link = t as Tokens.Link;
        const href = safeHref(link.href);
        const inner = renderInline(link.tokens, opts);
        if (!href) return <span key={k}>{inner}</span>;
        return (
          <a key={k} href={href} target="_blank" rel="noopener noreferrer">
            {inner}
          </a>
        );
      }
      case "image":
        return <span key={k}>{opts.renderText ? opts.renderText((t as Tokens.Image).text) : (t as Tokens.Image).text}</span>;
      case "br":
        return <br key={k} />;
      default:
        return null;
    }
  });
}

function listItem(item: Tokens.ListItem, opts: MarkdownRenderOptions, key: string): ReactNode {
  return (
    <li key={key}>
      {item.task && <input type="checkbox" disabled checked={item.checked === true} readOnly />}
      {withKeys(item.tokens ?? [], (t) => t.type).map(({ item: t, key: tk }) =>
        t.type === "text" ? (
          <span key={tk}>
            {"tokens" in t && t.tokens ? renderInline(t.tokens, opts) : (opts.renderText ? opts.renderText((t as Tokens.Text).text) : (t as Tokens.Text).text)}
          </span>
        ) : (
          renderBlock(t, opts, tk)
        )
      )}
    </li>
  );
}

function renderBlock(t: Token, opts: MarkdownRenderOptions, key: string): ReactNode {
  switch (t.type) {
    case "space":
    case "def":
      return null;
    case "paragraph":
      return <p key={key}>{renderInline((t as Tokens.Paragraph).tokens, opts)}</p>;
    case "heading": {
      const h = t as Tokens.Heading;
      const tag = `h${Math.min(h.depth, 4)}` as "h1" | "h2" | "h3" | "h4";
      const inner = renderInline(h.tokens, opts);
      return createElementFor(tag, key, inner);
    }
    case "code": {
      const code = t as Tokens.Code;
      return (
        <pre key={key}>
          <code
            className="hljs-theme"
            dangerouslySetInnerHTML={{ __html: highlightCode(code.text, code.lang || undefined) }}
          />
        </pre>
      );
    }
    case "hr":
      return <hr key={key} />;
    case "blockquote":
      return <blockquote key={key}>{withKeys((t as Tokens.Blockquote).tokens, (child) => child.type).map(({ item: child, key: ck }) => renderBlock(child, opts, ck))}</blockquote>;
    case "list": {
      const list = t as Tokens.List;
      const items = withKeys(list.items, () => "li").map(({ item, key: ik }) => listItem(item, opts, ik));
      if (!list.ordered) return <ul key={key}>{items}</ul>;
      return (
        <ol key={key} {...(list.start && list.start !== 1 ? { start: list.start } : {})}>
          {items}
        </ol>
      );
    }
    case "table": {
      const table = t as Tokens.Table;
      return (
        <table key={key}>
          <thead>
            <tr>
              {withKeys(table.header, () => "th").map(({ item: cell, key: hk }) => (
                <th key={hk}>{renderInline(cell.tokens, opts)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {withKeys(table.rows, () => "tr").map(({ item: row, key: rk }) => (
              <tr key={rk}>
                {withKeys(row, () => "td").map(({ item: cell, key: ck }) => (
                  <td key={ck}>{renderInline(cell.tokens, opts)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    case "html":
    case "tag":
      return null;
    case "text":
      return (
        <span key={key}>
          {"tokens" in t && t.tokens ? renderInline(t.tokens, opts) : (opts.renderText ? opts.renderText((t as Tokens.Text).text) : (t as Tokens.Text).text)}
        </span>
      );
    default:
      return null;
  }
}

function createElementFor(tag: "h1" | "h2" | "h3" | "h4", key: string, children: ReactNode): ReactNode {
  if (tag === "h1") return <h1 key={key}>{children}</h1>;
  if (tag === "h2") return <h2 key={key}>{children}</h2>;
  if (tag === "h3") return <h3 key={key}>{children}</h3>;
  return <h4 key={key}>{children}</h4>;
}

export function markdownToReact(md: string, opts: MarkdownRenderOptions = {}): ReactNode[] {
  return withKeys(marked.lexer(md), (t) => t.type)
    .map(({ item: t, key }) => renderBlock(t, opts, key))
    .filter((n) => n !== null);
}

interface MarkdownContentProps extends MarkdownRenderOptions {
  md: string;
  // Appended inline at the end of the last block element (streaming caret).
  trailing?: ReactNode;
}

// Content-address key for a completed top-level block. Index is part of the
// key so identical raw blocks never share one cached element (duplicate
// React keys).
function blockCacheKey(index: number, type: string, raw: string): string {
  let h = 5381;
  for (let i = 0; i < raw.length; i++) h = ((h << 5) + h + raw.charCodeAt(i)) | 0;
  return `${index}:${type}:${h.toString(36)}:${raw.length}`;
}

// Memoized per text so progressive stream deltas re-render only the changed
// turn, not every sibling bubble. Within a turn, COMPLETED blocks (every
// token before the last) are content-addressed and keep their ReactNode
// reference across frames — React bails out on an unchanged element
// reference, so per-delta work shrinks to lexing + re-rendering the trailing
// partial block instead of the whole reply. This is what keeps tables/lists
// from lagging behind the token stream.
export const MarkdownContent = memo(function MarkdownContent({ md, renderText, trailing }: MarkdownContentProps) {
  // One cache per renderText identity (the hook closes over project/slug —
  // cached nodes embed its output, so they must not survive an identity
  // change). The outer map only ever gains entries: no ref is written during
  // render; superseded inner maps become unreachable (GC) and each is pruned
  // to its own live keys every pass.
  const cachesRef = useRef<Map<typeof renderText, Map<string, ReactNode>>>(new Map());
  const nodes = useMemo(() => {
    let cache = cachesRef.current.get(renderText);
    if (cache === undefined) {
      cache = new Map<string, ReactNode>();
      cachesRef.current.set(renderText, cache);
    }
    const opts = { renderText };
    const tokens = marked.lexer(md);
    const out: ReactNode[] = [];
    const liveKeys = new Set<string>();
    const lastIdx = tokens.length - 1;
    withKeys(tokens, (t) => t.type).forEach(({ item: t, key: rk }, i) => {
      if (t.type === "space" || t.type === "def") return;
      if (i < lastIdx) {
        const key = blockCacheKey(i, t.type, t.raw);
        liveKeys.add(key);
        let node = cache.get(key);
        if (node === undefined) {
          node = renderBlock(t, opts, rk);
          cache.set(key, node);
        }
        out.push(node);
        return;
      }
      out.push(renderBlock(t, opts, rk));
    });
    for (const k of cache.keys()) if (!liveKeys.has(k)) cache.delete(k);
    if (!trailing) return out;
    let idx = -1;
    for (let i = out.length - 1; i >= 0; i--) {
      const n = out[i];
      if (isValidElement(n) && typeof n.type === "string" && BLOCK_TAGS.has(n.type)) {
        idx = i;
        break;
      }
    }
    if (idx >= 0) {
      const target = out[idx] as React.ReactElement<{ children?: ReactNode }>;
      out[idx] = cloneElement(target, {}, ...(Children.toArray(target.props.children ?? [])), trailing);
    } else {
      out.push(trailing);
    }
    return out;
  }, [md, renderText, trailing]);
  return <>{nodes}</>;
});