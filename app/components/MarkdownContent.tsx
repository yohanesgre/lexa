import { Children, cloneElement, isValidElement, memo, useMemo, useRef, type ReactNode } from "react";
import { marked } from "marked";
import { withKeys } from "../lib/withKeys";
import { BLOCK_TAGS, renderBlock, type MarkdownRenderOptions } from "../lib/markdownToReact";

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
