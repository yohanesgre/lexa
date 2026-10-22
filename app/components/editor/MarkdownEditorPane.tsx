import { useEffect, useMemo, useRef } from "react";
import { EditorView, ViewPlugin, getDefaultExtensions } from "@uiw/react-codemirror";
import type { ViewUpdate } from "@uiw/react-codemirror";
import { Annotation, EditorState, Prec, StateEffect, StateField, Transaction } from "@codemirror/state";
import { invertedEffects, isolateHistory, redo } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { cn } from "../ui/cn";
import { fetchMentionItems, type MentionItem } from "../../lib/mention-suggestion";
import { mentionAtCursor, type SourceMentionMatch } from "../../lib/markdown-source-mentions";

export const EMPTY_MARKDOWN_PLACEHOLDER = "Write Markdown here. The preview updates as you type.";

export interface MarkdownTarget {
  wrap: (before: string, after: string) => void;
  prefix: (prefix: string) => void;
  insert: (text: string) => void;
}

export interface MarkdownSource {
  getValue: () => string;
  getSelection: () => string;
  replace: (value: string) => boolean;
  subscribe: (listener: () => void) => () => void;
}

interface MarkdownEditorPaneProps {
  value: string;
  onChange: (source: string) => void;
  editable?: boolean | undefined;
  onEnter?: (() => void) | undefined;
  onEscape?: (() => void) | undefined;
  targetRef?: { current: MarkdownTarget | null } | undefined;
  sourceRef?: { current: MarkdownSource | null } | undefined;
  ariaLabel: string;
  placeholder?: string | undefined;
  variant?: "document" | "comment" | undefined;
  className?: string | undefined;
  hidden?: boolean | undefined;
  mentionSlug?: string | undefined;
  onPaste?: ((view: EditorView, event: ClipboardEvent) => boolean) | undefined;
  onDrop?: ((view: EditorView, event: DragEvent) => boolean) | undefined;
  onViewUpdate?: ((update: ViewUpdate) => void) | undefined;
}

const sourceLineEndings = (source: string): string[] => source.match(/\r\n?|\n/g) ?? [];
const editorSource = (source: string): string => source.replace(/\r\n?/g, "\n");
const replaceLineEndings = StateEffect.define<readonly string[]>();
const sourceUpdate = Annotation.define<"external" | "accept">();

// CodeMirror counts each line break once; retain its original bytes outside those coordinates.
function readSource(state: EditorState, endings: readonly string[], from = 0, to = state.doc.length): string {
  const first = state.doc.lineAt(from);
  const last = state.doc.lineAt(to);
  if (first.number === last.number) return first.text.slice(from - first.from, to - first.from);
  const parts = [first.text.slice(from - first.from)];
  for (let number = first.number; number < last.number; number++) {
    const line = state.doc.line(number + 1);
    parts.push(endings[number - 1] ?? "\n", line.text.slice(0, number + 1 === last.number ? to - line.from : undefined));
  }
  return parts.join("");
}

function preserveNativeComposition(event: KeyboardEvent): void {
  if (event.keyCode === 229 || event.isComposing) event.stopImmediatePropagation();
}

function sourceMentionHref(item: MentionItem, slug: string): string | null {
  const project = encodeURIComponent(slug);
  if (item.refType === "task") {
    return `/${project}/board?task=${encodeURIComponent(item.refId)}`;
  }
  if (item.refType === "wiki") {
    return `/${project}/wiki/${encodeURIComponent(item.refId)}`;
  }
  return null;
}

function insertSourceMention(view: EditorView, match: SourceMentionMatch, item: MentionItem, slug: string): void {
  const href = sourceMentionHref(item, slug);
  if (!href) return;
  const label = item.label.replace(/\r\n?|\n/g, " ").replace(/[\\`*_[\]<>|~&]/g, "\\$&");
  const insert = `[${label}](${href}) `;
  view.dispatch({
    changes: { from: match.from, to: match.to, insert },
    selection: { anchor: match.from + insert.length },
    userEvent: "input.complete",
  });
}
class SourceMentionPicker {
  private readonly popup = document.createElement("div");
  private focusedIndex = 0;
  private sequence = 0;
  private dismissed = false;
  private match: SourceMentionMatch | null = null;
  private items: MentionItem[] = [];

  constructor(
    private readonly view: EditorView,
    private readonly slug: string | undefined,
    private readonly editable: boolean
  ) {
    this.popup.className = "dropdown-menu mention-popup";
    this.popup.setAttribute("role", "listbox");
    this.popup.setAttribute("aria-label", "Task and wiki links");
    Object.assign(this.popup.style, { position: "fixed", zIndex: "60", width: "360px" });
    document.body.appendChild(this.popup);
    this.refresh();
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.selectionSet) this.dismissed = false;
    this.refresh();
  }

  destroy(): void {
    this.sequence++;
    this.popup.remove();
  }

  handleKeyDown(event: KeyboardEvent): boolean {
    if (!this.match || this.popup.hidden || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (this.items.length > 0) {
        const direction = event.key === "ArrowDown" ? 1 : -1;
        this.focusedIndex = (this.focusedIndex + direction + this.items.length) % this.items.length;
        this.paint();
        this.popup.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
      }
      event.preventDefault();
      return true;
    }
    if (event.key === "Enter") {
      const item = this.items[this.focusedIndex];
      if (!item || !this.slug) return false;
      insertSourceMention(this.view, this.match, item, this.slug);
      this.hide();
      event.preventDefault();
      return true;
    }
    if (event.key === "Escape") {
      this.dismissed = true;
      this.hide();
      event.preventDefault();
      return true;
    }
    if (event.key === "Tab") this.hide();
    return false;
  }

  private refresh(): void {
    if (!this.slug || !this.editable || !this.view.hasFocus || this.dismissed) {
      this.hide();
      return;
    }
    const match = mentionAtCursor(this.view.state);
    if (!match) {
      this.hide();
      return;
    }
    if (this.match?.from === match.from && this.match.query === match.query) return;
    this.match = match;
    this.items = [];
    this.focusedIndex = 0;
    this.popup.hidden = true;
    const sequence = ++this.sequence;
    void fetchMentionItems(this.slug, match.query).then((items) => {
      const current = mentionAtCursor(this.view.state);
      if (
        sequence !== this.sequence ||
        !this.view.dom.isConnected ||
        current?.from !== match.from ||
        current.query !== match.query
      ) return;
      this.items = items.filter((item) => item.refType === "task" || item.refType === "wiki");
      this.popup.hidden = false;
      this.paint();
      this.position(match);
    });
  }

  private position(match: SourceMentionMatch): void {
    this.view.requestMeasure({
      key: this,
      read: (view) => {
        const coords = this.match === match ? view.coordsAtPos(match.to) : null;
        return coords ? { coords, height: this.popup.getBoundingClientRect().height } : null;
      },
      write: (measurement) => {
        if (this.match !== match || !this.popup.isConnected) return;
        if (!measurement) {
          this.popup.hidden = true;
          return;
        }
        const { coords, height } = measurement;
        const below = coords.bottom + 6;
        this.popup.style.left = `${Math.max(8, Math.min(coords.left, window.innerWidth - 368))}px`;
        this.popup.style.top = `${below + height <= window.innerHeight - 8 ? below : Math.max(8, coords.top - height - 6)}px`;
      },
    });
  }

  private paint(): void {
    this.popup.replaceChildren();
    if (!this.items.length) {
      const empty = document.createElement("div");
      empty.className = "dropdown-item";
      empty.textContent = "No matches";
      this.popup.appendChild(empty);
      return;
    }
    for (const [index, item] of this.items.entries()) {
      if (index === 0 || this.items[index - 1]?.refType !== item.refType) {
        if (index > 0) {
          const separator = document.createElement("div");
          separator.className = "dropdown-separator";
          this.popup.appendChild(separator);
        }
        const section = document.createElement("div");
        section.className = "dropdown-label";
        section.textContent = item.refType === "task" ? "Tasks" : "Wiki";
        this.popup.appendChild(section);
      }
      const row = document.createElement("div");
      row.className = `dropdown-item${index === this.focusedIndex ? " focused" : ""}`;
      row.dataset.index = String(index);
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(index === this.focusedIndex));
      const label = document.createElement("span");
      label.className = item.refType === "task" ? "task-key" : "dd-sub truncate";
      if (item.refType === "task") label.style.fontSize = "13px";
      label.textContent = item.label;
      const detail = document.createElement("span");
      detail.className = item.refType === "task" ? "dd-sub truncate" : "font-mono text-xs text-lx-text-muted";
      detail.textContent = item.sublabel;
      row.append(label, detail);
      row.addEventListener("mousedown", (event) => {
        event.preventDefault();
        const match = this.match;
        if (match && this.slug) insertSourceMention(this.view, match, item, this.slug);
        this.hide();
      });
      this.popup.appendChild(row);
    }
  }

  private hide(): void {
    this.sequence++;
    this.match = null;
    this.items = [];
    this.popup.hidden = true;
  }
}


export function MarkdownEditorPane({
  value,
  onChange,
  editable = true,
  onEnter,
  onEscape,
  targetRef,
  sourceRef,
  ariaLabel,
  placeholder = EMPTY_MARKDOWN_PLACEHOLDER,
  variant = "document",
  className,
  hidden,
  mentionSlug,
  onPaste,
  onDrop,
  onViewUpdate,
}: MarkdownEditorPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<{ view: EditorView } | null>(null);
  const liveStateRef = useRef<EditorState | null>(null);
  const callbacksRef = useRef({ onChange, onEnter, onEscape, onPaste, onDrop, onViewUpdate, editable, mentionSlug });
  callbacksRef.current = { onChange, onEnter, onEscape, onPaste, onDrop, onViewUpdate, editable, mentionSlug };
  const valueRef = useRef(value);
  valueRef.current = value;
  const selectionListenersRef = useRef(new Set<() => void>());
  // Focus the pane once, on its first editable update: it mounts when its owner
  // switches into editing, and a later editable flip (closing a revision
  // preview) must not steal focus from the control the user just pressed.
  const autoFocusedRef = useRef(false);
  const lineEndings = useMemo(() => StateField.define<readonly string[]>({
    create: () => sourceLineEndings(valueRef.current),
    update: (previous, transaction) => {
      const replacement = transaction.effects.filter((effect) => effect.is(replaceLineEndings)).at(-1);
      if (replacement) return replacement.value;
      if (!transaction.docChanged) return previous;
      const next: string[] = [];
      let cursor = 0;
      transaction.changes.iterChanges((from, to, _fromNew, _toNew, inserted) => {
        const first = transaction.startState.doc.lineAt(from).number - 1;
        const last = transaction.startState.doc.lineAt(to).number - 1;
        next.push(...previous.slice(cursor, first), ...Array<string>(inserted.lines - 1).fill("\n"));
        cursor = last;
      });
      next.push(...previous.slice(cursor));
      return next;
    },
  }), []);
  const extensions = useMemo(() => {
    const pickers = mentionSlug && editable ? new WeakMap<EditorView, SourceMentionPicker>() : undefined;
    return [
      ...getDefaultExtensions({
        theme: "none",
        editable,
        readOnly: !editable,
        indentWithTab: false,
        placeholder,
        basicSetup: {
          lineNumbers: false,
          foldGutter: false,
          foldKeymap: false,
          highlightActiveLine: false,
          highlightActiveLineGutter: false,
          highlightSelectionMatches: false,
          syntaxHighlighting: false,
          bracketMatching: false,
          closeBrackets: false,
          autocompletion: false,
          searchKeymap: false,
        },
      }),
      EditorState.transactionFilter.of((transaction) =>
        transaction.docChanged && transaction.startState.readOnly && !transaction.annotation(sourceUpdate) ? [] : transaction),
      lineEndings,
      invertedEffects.of((transaction) => transaction.docChanged || transaction.effects.some((effect) => effect.is(replaceLineEndings))
        ? [replaceLineEndings.of(transaction.startState.field(lineEndings))]
        : []),
      markdown(),
      EditorState.tabSize.of(2),
      EditorView.theme({
        "&": { backgroundColor: "transparent", color: "inherit", fontSize: "inherit", height: "100%" },
        "&.cm-focused": { outline: "none" },
        ".cm-scroller": { fontFamily: "inherit", lineHeight: "inherit", overflow: "auto", height: "100% !important" },
        ".cm-content": {
          minHeight: variant === "comment" ? "64px" : "120px",
          padding: variant === "comment" ? "10px 12px" : "var(--lx-space-6)",
          caretColor: "var(--lx-border-focus)",
          outline: "none",
          boxShadow: "none",
        },
        ".cm-line": { padding: "0" },
        ".cm-placeholder, .cm-specialChar": { color: "var(--lx-text-muted)" },
        ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--lx-border-focus)" },
        "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
          backgroundColor: "var(--lx-surface-selected)",
        },
      }),
      ViewPlugin.fromClass(class {
        private readonly picker: SourceMentionPicker | undefined;
        constructor(private readonly view: EditorView) {
          if (pickers) {
            this.picker = new SourceMentionPicker(view, mentionSlug, editable);
            pickers.set(view, this.picker);
          }
          // CodeMirror's handled-event path cancels the browser's native IME commit.
          view.contentDOM.addEventListener("keydown", preserveNativeComposition, true);
        }
        update(update: ViewUpdate) {
          this.picker?.update(update);
        }
        destroy() {
          this.picker?.destroy();
          this.view.contentDOM.removeEventListener("keydown", preserveNativeComposition, true);
        }
      }),
      Prec.highest(
        EditorView.domEventHandlers({
          keydown(event, view) {
            if (pickers?.get(view)?.handleKeyDown(event)) {
              event.stopPropagation();
              return true;
            }
            if (!callbacksRef.current.editable && event.key !== "Escape") return false;
            // Resolve shifted redo before the generic single-character keymap.
            if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "z") {
              event.preventDefault();
              event.stopPropagation();
              redo(view);
              return true;
            }
            if (event.key === "Enter" && !event.shiftKey && callbacksRef.current.onEnter) {
              event.preventDefault();
              event.stopPropagation();
              callbacksRef.current.onEnter();
              return true;
            }
            if (event.key === "Escape" && callbacksRef.current.onEscape) {
              event.preventDefault();
              event.stopPropagation();
              callbacksRef.current.onEscape();
              return true;
            }
            return false;
          },
          paste(event, view) {
            if (!callbacksRef.current.editable) return false;
            return callbacksRef.current.onPaste?.(view, event as ClipboardEvent) ?? false;
          },
          drop(event, view) {
            if (!callbacksRef.current.editable) return false;
            return callbacksRef.current.onDrop?.(view, event as DragEvent) ?? false;
          },
        })
      ),
      EditorView.updateListener.of((update) => {
        callbacksRef.current.onViewUpdate?.(update);
        if (update.docChanged && !update.transactions.some((transaction) => transaction.annotation(sourceUpdate) === "external")) {
          callbacksRef.current.onChange(readSource(update.state, update.state.field(lineEndings)));
        }
        if (update.selectionSet || update.docChanged) {
          for (const listener of selectionListenersRef.current) listener();
        }
      }),
      EditorView.contentAttributes.of({
        "aria-label": ariaLabel,
        role: "textbox",
        "aria-multiline": "true",
      }),
    ];
  }, [ariaLabel, editable, mentionSlug, variant, placeholder, lineEndings]);

  const extensionsRef = useRef(extensions);
  extensionsRef.current = extensions;
  const configuredExtensionsRef = useRef<typeof extensions | null>(null);
  useEffect(() => {
    if (!containerRef.current) return;
    // Own native updates: the React wrapper defers prop replacements while typing.
    const view = new EditorView({
      parent: containerRef.current,
      state: EditorState.create({ doc: editorSource(valueRef.current), extensions: extensionsRef.current }),
    });
    editorRef.current = { view };
    return () => {
      editorRef.current = null;
      configuredExtensionsRef.current = null;
      liveStateRef.current = null;
      autoFocusedRef.current = false;
      view.destroy();
    };
  }, []);

  const target = useMemo<MarkdownTarget>(
    () => ({
      wrap: (before, after) => {
        const view = editorRef.current?.view;
        if (!view || !callbacksRef.current.editable) return;
        const { from, to } = view.state.selection.main;
        const text = view.state.sliceDoc(from, to);
        view.dispatch({
          changes: [{ from, insert: before }, { from: to, insert: after }],
          selection: { anchor: from + view.state.toText(before).length, head: from + view.state.toText(before).length + text.length },
        });
        view.focus();
      },
      prefix: (prefix) => {
        const view = editorRef.current?.view;
        if (!view || !callbacksRef.current.editable) return;
        const { from, to } = view.state.selection.main;
        const first = view.state.doc.lineAt(from);
        const last = view.state.doc.lineAt(to);
        const lines = Array.from({ length: last.number - first.number + 1 }, (_, i) => view.state.doc.line(first.number + i));
        const allPrefixed = lines.every((line) => line.text.startsWith(prefix));
        const changes = lines.map((line) => ({
          from: line.from,
          to: allPrefixed ? line.from + prefix.length : line.from + (line.text.match(/^(#{2,5} |> |- \[[ x]\] |- |\d+\. )/)?.[0].length ?? 0),
          insert: allPrefixed ? "" : prefix,
        }));
        const changeSet = view.state.changes(changes);
        view.dispatch({
          changes: changeSet,
          selection: { anchor: first.from, head: changeSet.mapPos(last.to, 1) },
          userEvent: "input",
        });
        view.focus();
      },
      insert: (snippet) => {
        const view = editorRef.current?.view;
        if (!view || !callbacksRef.current.editable) return;
        const { from, to } = view.state.selection.main;
        const before = view.state.sliceDoc(0, from);
        const padded = before === "" || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
        const insert = `${padded}${snippet}\n`;
        const caret = from + view.state.toText(insert).length;
        view.dispatch({
          changes: { from, to, insert },
          selection: { anchor: caret },
          userEvent: "input",
        });
        view.focus();
      },
    }),
    [editable]
  );

  useEffect(() => {
    if (!targetRef) return;
    targetRef.current = target;
    return () => {
      targetRef.current = null;
    };
  }, [target, targetRef]);

  const source = useMemo<MarkdownSource>(
    () => ({
      getValue: () => {
        const state = editorRef.current?.view?.state;
        return state ? readSource(state, state.field(lineEndings)) : valueRef.current;
      },
      getSelection: () => {
        const view = editorRef.current?.view;
        if (!view) return "";
        const { from, to } = view.state.selection.main;
        return readSource(view.state, view.state.field(lineEndings), from, to);
      },
      replace: (next) => {
        const view = editorRef.current?.view;
        if (!view || liveStateRef.current) return false;
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: next },
          selection: { anchor: view.state.toText(next).length },
          effects: replaceLineEndings.of(sourceLineEndings(next)),
          annotations: [sourceUpdate.of("accept"), isolateHistory.of("full")],
          userEvent: "input",
        });
        view.focus();
        return true;
      },
      subscribe: (listener) => {
        selectionListenersRef.current.add(listener);
        return () => selectionListenersRef.current.delete(listener);
      },
    }),
    [lineEndings]
  );

  useEffect(() => {
    if (!sourceRef) return;
    sourceRef.current = source;
    return () => {
      sourceRef.current = null;
    };
  }, [source, sourceRef]);

  useEffect(() => {
    const view = editorRef.current?.view;
    if (!view) return;
    const current = readSource(view.state, view.state.field(lineEndings));
    if (!editable && current !== value) {
      // Historical projections never map changes through the live draft's history.
      liveStateRef.current ??= view.state;
      view.setState(EditorState.create({ doc: editorSource(value), extensions }));
      configuredExtensionsRef.current = extensions;
      for (const listener of selectionListenersRef.current) listener();
    } else if (editable && liveStateRef.current) {
      const live = liveStateRef.current;
      liveStateRef.current = null;
      view.setState(live.update({ effects: StateEffect.reconfigure.of(extensions) }).state);
      configuredExtensionsRef.current = extensions;
      for (const listener of selectionListenersRef.current) listener();
    }
    if (configuredExtensionsRef.current !== extensions) {
      view.dispatch({ effects: StateEffect.reconfigure.of(extensions) });
      configuredExtensionsRef.current = extensions;
    }
    if (editable && readSource(view.state, view.state.field(lineEndings)) !== value) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: editorSource(value) },
        effects: replaceLineEndings.of(sourceLineEndings(value)),
        annotations: [sourceUpdate.of("external"), Transaction.addToHistory.of(false)],
      });
    }
    if (!autoFocusedRef.current && editable) {
      autoFocusedRef.current = true;
      view.focus();
    }
  }, [value, editable, extensions, lineEndings]);

  return (
    <div className={cn("md-pane", className)} hidden={hidden} style={variant === "comment" ? { minHeight: 64 } : undefined}>
      <div
        ref={containerRef}
        className={cn("cm-theme-none", variant === "comment" ? "composer-editor" : "md-source")}
        style={{ padding: 0 }}
        aria-label={ariaLabel}
        spellCheck={false}
      />
    </div>
  );
}
