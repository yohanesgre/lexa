import Mention from "@tiptap/extension-mention";
import type { Editor, Range } from "@tiptap/core";
import type { SuggestionOptions } from "@tiptap/suggestion";
import type { MentionOptions } from "@tiptap/extension-mention";

// Mentions autocomplete (mentions-autocomplete.html): one picker keyed on
// "@" for TipTap document editors. Picking a row inserts a mention NODE —
// documents get a LINK only, never attached context (split model).

export type MentionRefType = "task" | "wiki" | "milestone" | "swimlane" | "column" | "skill";

export interface MentionItem {
  refType: MentionRefType;
  refId: string;
  label: string;
  sublabel: string;
  // Raw token the chat composer inserts. Entities use their derived slug; the
  // TipTap document path links via refId/label and ignores this.
  insertToken?: string | undefined;
}

// Section order + copy pinned by mentions-autocomplete.html. Skills are a
// separate `$` picker and never appear in the `@` sections.
export const MENTION_SECTIONS: { refType: MentionRefType; label: string }[] = [
  { refType: "task", label: "Tasks" },
  { refType: "wiki", label: "Wiki" },
  { refType: "milestone", label: "Milestones" },
  { refType: "swimlane", label: "Swimlanes" },
  { refType: "column", label: "Columns" },
];

export function mentionChipClass(refType: MentionRefType): string {
  return refType === "skill" ? "mention-chip-skill" : "mention-chip";
}

interface MentionEntityHit {
  id: string;
  name: string;
  slug: string;
  sublabel: string | null;
}

interface MentionsResponse {
  data?: {
    tasks?: { id: string; key: string; title: string }[];
    wikiPages?: { id: string; slug: string; title: string }[];
    milestones?: MentionEntityHit[];
    swimlanes?: MentionEntityHit[];
    columns?: MentionEntityHit[];
  };
}

// Query charset pinned by the contract: word-boundary characters only.
// Anything else (spaces, punctuation, attempteds like "java script") yields
// no results rather than hitting the endpoint.
const QUERY_RE = /^[A-Za-z0-9-]*$/;

export function isValidMentionQuery(query: string): boolean {
  return QUERY_RE.test(query);
}

export async function fetchMentionItems(slug: string, query: string): Promise<MentionItem[]> {
  // Empty query (bare "@") is allowed through: the server returns default
  // suggestions (recent tasks + wiki). Only invalid characters bail out.
  if (!isValidMentionQuery(query)) return [];
  const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/mentions?q=${encodeURIComponent(query)}`);
  if (!res.ok) return [];
  const body = (await res.json()) as MentionsResponse;
  const tasks = (body.data?.tasks ?? []).map((t) => ({
    refType: "task" as const,
    refId: t.id,
    label: t.key,
    sublabel: t.title,
    insertToken: t.key,
  }));
  const wiki = (body.data?.wikiPages ?? []).map((w) => ({
    refType: "wiki" as const,
    refId: w.slug,
    label: w.title,
    sublabel: w.slug,
    insertToken: w.slug,
  }));
  // Milestones/swimlanes/columns have no slug column; the server's derived
  // `slug` is the mention token and also the popup's right-aligned sublabel.
  const entities = (rows: MentionEntityHit[] | undefined, refType: MentionRefType): MentionItem[] =>
    (rows ?? []).map((e) => ({
      refType,
      refId: e.id,
      label: e.name,
      sublabel: e.slug,
      insertToken: e.slug,
    }));
  // Server caps tasks+wiki at 8 combined and each entity array at 8; the
  // popup renders only non-empty sections in MENTION_SECTIONS order.
  return [
    ...tasks,
    ...wiki,
    ...entities(body.data?.milestones, "milestone"),
    ...entities(body.data?.swimlanes, "swimlane"),
    ...entities(body.data?.columns, "column"),
  ];
}

export function insertMentionAtRange(editor: Editor, range: Range, item: MentionItem): void {
  editor
    .chain()
    .focus()
    .insertContentAt(range, [
      { type: "mention", attrs: { refType: item.refType, refId: item.refId, label: item.label } },
      { type: "text", text: " " },
    ])
    .run();
}

// Dropdown DOM transcribed from mentions-autocomplete.html:
// .dropdown-menu > .dropdown-label "Tasks" / rows / separator / "Wiki" / rows;
// keyboard focus rides .dropdown-item.focused (§6.7 selected bg + ring).
export function createMentionDropdownRenderer() {
  let popup: HTMLDivElement | null = null;
  let items: MentionItem[] = [];
  let focusIndex = 0;
  let query = "";
  let command: ((item: MentionItem) => void) | null = null;

  const rowHtml = (item: MentionItem, index: number): string => {
    const focused = index === focusIndex ? " focused" : "";
    if (item.refType === "task") {
      return `<div class="dropdown-item${focused}" data-index="${index}" role="option" aria-selected="${index === focusIndex}">` +
        `<span class="task-key" style="font-size:13px;">${escapeHtml(item.label)}</span>` +
        `<span class="dd-sub truncate">${escapeHtml(item.sublabel)}</span></div>`;
    }
    return `<div class="dropdown-item${focused}" data-index="${index}" role="option" aria-selected="${index === focusIndex}">` +
      `<span class="dd-sub truncate">${escapeHtml(item.label)}</span>` +
      `<span class="font-mono text-xs text-lx-text-muted">${escapeHtml(item.sublabel)}</span></div>`;
  };

  const paint = () => {
    if (!popup) return;
    if (items.length === 0) {
      popup.innerHTML =
        `<div class="dropdown-item" style="cursor:default;color:var(--lx-text-muted);">No matches for "${escapeHtml(query)}"</div>`;
      return;
    }
    const sections = MENTION_SECTIONS.map((section) => ({
      section,
      rows: items.map((item, index) => ({ item, index })).filter(({ item }) => item.refType === section.refType),
    })).filter(({ rows }) => rows.length > 0);
    let html = "";
    sections.forEach(({ section, rows }, sectionIndex) => {
      if (sectionIndex > 0) html += `<div class="dropdown-separator"></div>`;
      html += `<div class="dropdown-label">${section.label}</div>`;
      html += rows.map(({ item, index }) => rowHtml(item, index)).join("");
    });
    popup.innerHTML = html;
  };

  const bindClicks = () => {
    if (!popup) return;
    popup.querySelectorAll<HTMLElement>(".dropdown-item[data-index]").forEach((el) => {
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const item = items[Number(el.dataset.index)];
        if (item && command) command(item);
      });
    });
  };

  const position = (clientRect: (() => DOMRect | null) | null | undefined) => {
    if (!popup) return;
    const rect = clientRect?.();
    if (!rect) {
      popup.style.display = "none";
      return;
    }
    popup.style.display = "";
    popup.style.left = `${Math.min(rect.left, window.innerWidth - 380)}px`;
    popup.style.top = `${rect.bottom + 6}px`;
  };

  const sync = (props: {
    items: MentionItem[];
    query: string;
    clientRect?: (() => DOMRect | null) | null;
    command: (item: MentionItem) => void;
  }) => {
    const changed = props.items !== items || props.query !== query;
    items = props.items;
    query = props.query;
    command = props.command;
    if (focusIndex >= items.length) focusIndex = Math.max(0, items.length - 1);
    if (!popup) {
      popup = document.createElement("div");
      popup.className = "dropdown-menu mention-popup";
      popup.setAttribute("role", "listbox");
      Object.assign(popup.style, { position: "fixed", zIndex: 60, width: "360px" });
      document.body.appendChild(popup);
    }
    if (changed) {
      paint();
      bindClicks();
    }
    position(props.clientRect);
  };

  const destroy = () => {
    popup?.remove();
    popup = null;
    items = [];
    focusIndex = 0;
    command = null;
  };

  return {
    onStart: sync,
    onUpdate: sync,
    onExit: destroy,
    onKeyDown: ({ event }: { event: KeyboardEvent }): boolean => {
      if (!popup) return false;
      if (event.key === "ArrowDown") {
        focusIndex = items.length === 0 ? 0 : (focusIndex + 1) % items.length;
        paint();
        bindClicks();
        return true;
      }
      if (event.key === "ArrowUp") {
        focusIndex = items.length === 0 ? 0 : (focusIndex - 1 + items.length) % items.length;
        paint();
        bindClicks();
        return true;
      }
      if (event.key === "Enter") {
        const item = items[focusIndex];
        if (item && command) {
          command(item);
          return true;
        }
        return false;
      }
      if (event.key === "Escape") {
        destroy();
        return true;
      }
      return false;
    },
  };
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

export interface MentionExtensionOptions {
  slug: string;
  debounceMs?: number | undefined;
  fetchMentions?: (slug: string, query: string) => Promise<MentionItem[]>;
}

// Pure suggestion-config builder — exposed for tests (debounce, items
// mapping, command insertion against a real editor).
export function buildMentionSuggestion(opts: MentionExtensionOptions): Record<string, unknown> {
  const fetchMentions = opts.fetchMentions ?? fetchMentionItems;
  return {
    char: "@",
    debounce: opts.debounceMs ?? 150,
    items: async ({ query }: { query: string }) => fetchMentions(opts.slug, query),
    command: ({ editor, range, props }: { editor: Editor; range: Range; props: MentionItem }) =>
      insertMentionAtRange(editor, range, props),
    render: createMentionDropdownRenderer,
  };
}

// Per-editor factory — NEVER bake into the module-level textEditorExtensions
// list: extension instances are stateful and surfaces like CommentCard clone
// that list per editor (.map), which would share one suggestion plugin
// across every open editor.
export function createMentionExtension(opts: MentionExtensionOptions) {
  const CustomMention = Mention.extend({
    addAttributes() {
      return {
        refType: {
          default: "task",
          parseHTML: (el: HTMLElement) => el.getAttribute("data-ref-type") ?? "task",
        },
        refId: {
          default: null,
          parseHTML: (el: HTMLElement) => el.getAttribute("data-ref-id"),
        },
        label: {
          default: null,
          parseHTML: (el: HTMLElement) => el.getAttribute("data-label"),
        },
      };
    },
    renderText({ node }: { node: { attrs: { label?: string | null | undefined; refId?: string | null } } }) {
      return `@${node.attrs.label ?? node.attrs.refId ?? ""}`;
    },
    renderHTML({ node }: { node: { attrs: { refType?: string | undefined; refId?: string | null | undefined; label?: string | null } } }) {
      return [
        "span",
        {
          class: mentionChipClass((node.attrs.refType ?? "task") as MentionRefType),
          "data-ref-type": node.attrs.refType ?? "task",
          "data-ref-id": node.attrs.refId ?? "",
        },
        `@${node.attrs.label ?? node.attrs.refId ?? ""}`,
      ];
    },
  });
  return CustomMention.configure({
    deleteTriggerWithBackspace: true,
    suggestion: buildMentionSuggestion(opts) as MentionOptions["suggestion"],
  });
}
