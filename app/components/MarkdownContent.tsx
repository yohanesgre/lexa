import { Children, cloneElement, isValidElement, memo, type ReactNode } from "react";
import { BLOCK_TAGS, markdownToReact, type MarkdownRenderOptions } from "../lib/markdownToReact";

interface MarkdownContentProps extends MarkdownRenderOptions {
  md: string;
  trailing?: ReactNode;
}

export const MarkdownContent = memo(function MarkdownContent({ md, renderText, surface, share, headingIds, headingAnchors, trailing }: MarkdownContentProps) {
  const rendered = markdownToReact(md, { renderText, surface, share, headingIds, headingAnchors });
  const nodes = Children.toArray(rendered);
  if (trailing) {
    let idx = -1;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      if (isValidElement(node) && typeof node.type === "string" && BLOCK_TAGS[node.type] === true) {
        idx = i;
        break;
      }
    }
    if (idx >= 0) {
      const target = nodes[idx] as React.ReactElement<{ children?: ReactNode }>;
      nodes[idx] = cloneElement(target, {}, ...Children.toArray(target.props.children ?? []), trailing);
    } else {
      nodes.push(...Children.toArray(trailing));
    }
  }
  return <>{nodes}</>;
});
