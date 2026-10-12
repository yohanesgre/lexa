import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { TipTapDoc } from "../../../shared/types";
import {
  carryNonMarkdownContent,
  docToMarkdown,
  markdownToDoc,
  type DocToMarkdownOptions,
  type MarkdownToDocOptions,
} from "../../../shared/markdown";
import { cn } from "../ui/cn";

// Fast enough that the preview follows the typing, slow enough that the
// document is not re-parsed on every keystroke.
const COMMIT_DELAY_MS = 300;

export const EMPTY_MARKDOWN_PLACEHOLDER = "Write Markdown here. The preview updates as you type.";

export interface MarkdownTarget {
  wrap: (before: string, after: string) => void;
  prefix: (prefix: string) => void;
  insert: (text: string) => void;
}

interface MarkdownEditorPaneProps {
  doc: TipTapDoc;
  slug?: string | undefined;
  editable?: boolean | undefined;
  onDocChange: (doc: TipTapDoc) => void;
  onEnter?: (() => void) | undefined;
  onEscape?: (() => void) | undefined;
  targetRef?: { current: MarkdownTarget | null } | undefined;
  ariaLabel: string;
  className?: string | undefined;
}

export function MarkdownEditorPane({
  doc,
  slug,
  editable = true,
  onDocChange,
  onEnter,
  onEscape,
  targetRef,
  ariaLabel,
  className,
}: MarkdownEditorPaneProps) {
  // A mention is written as the deep link this module emits, so the round trip
  // needs the project; a root-relative base keeps the text host-agnostic and
  // leaves attachment srcs untouched.
  const renderOptions = useMemo<DocToMarkdownOptions | undefined>(
    () => (slug ? { baseUrl: "", projectSlug: slug } : undefined),
    [slug]
  );
  const parseOptions = useMemo<MarkdownToDocOptions | undefined>(
    () => (slug ? { mentions: { projectSlug: slug, baseUrl: "" } } : undefined),
    [slug]
  );

  const [text, setText] = useState(() => docToMarkdown(doc, renderOptions));
  // The last document this pane produced, and the last one it saw. The surface
  // hands our own commit back as the same object, so identity — not text
  // equality — separates "our edit echoed back" from a document replaced by
  // someone else (page switch, revision preview, cancel, accepted Assistant
  // result). Only the second one rewrites the text under the cursor.
  const committedRef = useRef(doc);
  const documentRef = useRef(doc);
  const optionsRef = useRef(renderOptions);
  const pendingRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const replaced = doc !== committedRef.current || optionsRef.current !== renderOptions;
    optionsRef.current = renderOptions;
    documentRef.current = doc;
    if (!replaced) return;
    pendingRef.current = null;
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setText(docToMarkdown(doc, renderOptions));
  }, [doc, renderOptions]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    []
  );

  const commit = (value: string): void => {
    const merged = carryNonMarkdownContent(documentRef.current, markdownToDoc(value, parseOptions));
    committedRef.current = merged;
    onDocChange(merged);
  };

  const flush = (): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending !== null) commit(pending);
  };

  const discardPending = (): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = null;
  };

  const applyText = (next: string, selectionStart: number, selectionEnd: number): void => {
    setText(next);
    pendingRef.current = next;
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending !== null) commit(pending);
    }, COMMIT_DELAY_MS);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(selectionStart, selectionEnd);
    });
  };

  // The toolbar's controls act on this source: wrap the selection, prefix the
  // selected (or current) lines, or insert a block at the caret.
  const target = useMemo<MarkdownTarget>(
    () => ({
      wrap: (before, after) => {
        const el = textareaRef.current;
        if (!el) return;
        const { selectionStart: s, selectionEnd: e } = el;
        const value = text;
        const selected = value.slice(s, e);
        applyText(`${value.slice(0, s)}${before}${selected}${after}${value.slice(e)}`, s + before.length, e + before.length);
      },
      prefix: (prefix) => {
        const el = textareaRef.current;
        if (!el) return;
        const value = text;
        const { selectionStart: s, selectionEnd: e } = el;
        const lineStart = value.lastIndexOf("\n", Math.max(0, s - 1)) + 1;
        const lineEnd = value.indexOf("\n", e) === -1 ? value.length : value.indexOf("\n", e);
        const block = value.slice(lineStart, lineEnd);
        const lines = block.split("\n");
        const allPrefixed = lines.every((line) => line.startsWith(prefix));
        const next = lines
          .map((line) => (allPrefixed ? line.slice(prefix.length) : `${prefix}${line.replace(/^(#{2,5} |> |- \[[ x]\] |- |\d+\. )/, "")}`))
          .join("\n");
        applyText(`${value.slice(0, lineStart)}${next}${value.slice(lineEnd)}`, lineStart, lineStart + next.length);
      },
      insert: (snippet) => {
        const el = textareaRef.current;
        if (!el) return;
        const value = text;
        const { selectionStart: s, selectionEnd: e } = el;
        const before = value.slice(0, s);
        const padded = before === "" || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
        const next = `${before}${padded}${snippet}\n${value.slice(e)}`;
        const caret = before.length + padded.length + snippet.length + 1;
        applyText(next, caret, caret);
      },
    }),
    [text]
  );

  useEffect(() => {
    if (!targetRef) return;
    targetRef.current = target;
    return () => {
      targetRef.current = null;
    };
  }, [target, targetRef]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && onEnter) {
      event.preventDefault();
      flush();
      onEnter();
      return;
    }
    if (event.key === "Escape" && onEscape) {
      event.preventDefault();
      discardPending();
      onEscape();
    }
  };

  return (
    <div className={cn("md-pane", className)}>
      <textarea
        ref={textareaRef}
        className="md-source"
        value={text}
        aria-label={ariaLabel}
        placeholder={EMPTY_MARKDOWN_PLACEHOLDER}
        readOnly={!editable}
        aria-readonly={!editable || undefined}
        spellCheck={false}
        onChange={(event) => {
          const el = event.target;
          setText(el.value);
          pendingRef.current = el.value;
          if (timerRef.current !== null) clearTimeout(timerRef.current);
          timerRef.current = setTimeout(() => {
            timerRef.current = null;
            const pending = pendingRef.current;
            pendingRef.current = null;
            if (pending !== null) commit(pending);
          }, COMMIT_DELAY_MS);
        }}
        onBlur={flush}
        onKeyDown={handleKeyDown}
      />
    </div>
  );
}
