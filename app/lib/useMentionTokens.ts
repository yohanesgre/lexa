import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { fetchMentionItems, isValidMentionQuery, type MentionItem } from "./mention-suggestion";

// Chat composer autocomplete (mentions-autocomplete.html, composer variant):
// plain textarea + caret-positioned dropdown — no TipTap. Same trigger and
// keyboard model as the editor picker; picking inserts a RAW TOKEN
// (@LEX-n / @wiki-slug) into the message text at the caret.

const TRIGGER_RE = /(^|[^A-Za-z0-9-])@([A-Za-z0-9-]*)$/;

export function findActiveTrigger(value: string, caret: number): { query: string; start: number } | null {
  const before = value.slice(0, caret);
  const match = TRIGGER_RE.exec(before);
  if (!match) return null;
  // start = position of "@" (prefix + trigger), so completion replaces it.
  return { query: match[2]!, start: match.index! + match[1]!.length };
}

// Replaces "@query" (trigger through caret) with the completed token.
export function applyCompletion(value: string, caret: number, start: number, token: string): { value: string; caret: number } {
  // Skip the trailing separator when the caret already sits before whitespace.
  const needsSpace = !/\s/.test(value[caret] ?? "");
  const tokenText = `@${token}${needsSpace ? " " : ""}`;
  const next = value.slice(0, start) + tokenText + value.slice(caret);
  return { value: next, caret: start + tokenText.length };
}

// ── Popup placement (user ruling: anchor DIRECTLY ABOVE the text cursor) ──

export const MENTION_POPUP_GAP = 6;

// Pure branch math — tested directly (jsdom has no layout). The FLIP decision
// runs in VIEWPORT space (can the popup fit between the viewport top and the
// caret?) — never in container space, or a caret near the top of its own box
// would wrongly flip down. `top` comes back in container space for the
// absolutely-positioned popup inside the positioned composer container;
// negative tops are correct there (popup floats above the box, .composer does
// not clip).
export function positionPopup(input: {
  caretX: number;
  caretContainerY: number;
  caretViewportY: number;
  caretLineHeight?: number | undefined;
  popupWidth: number;
  popupHeight: number;
  containerWidth: number;
  gap?: number | undefined;
}): { left: number; top: number; flipped: boolean } {
  const gap = input.gap ?? MENTION_POPUP_GAP;
  const flipped = input.caretViewportY - input.popupHeight - gap < 0;
  const top = flipped
    ? input.caretContainerY + (input.caretLineHeight ?? 20) + gap
    : input.caretContainerY - input.popupHeight - gap;
  const maxLeft = Math.max(0, input.containerWidth - input.popupWidth);
  return { left: Math.min(Math.max(0, input.caretX), maxLeft), top, flipped };
}

const POPUP_WIDTH = 360;
const POPUP_MAX_HEIGHT = 264;
const ROW_HEIGHT = 32;
const LABEL_HEIGHT = 22;

function estimatePopupHeight(itemCount: number): number {
  if (itemCount === 0) return ROW_HEIGHT; // single "No matches" row
  const rows = itemCount * ROW_HEIGHT;
  const labels = 2 * LABEL_HEIGHT; // Tasks + Wiki section labels (upper bound)
  const separators = itemCount > 1 ? 9 : 0;
  return Math.min(rows + labels + separators + 8, POPUP_MAX_HEIGHT);
}

// Caret coordinates via the hidden mirror div (textarea-caret technique):
// replicate the textarea's typography + padding WITHOUT its border, copy text
// up to selectionStart, append a zero-width marker span, read its offsets.
// Convention (CSSOM): an element's offsetTop/offsetLeft are measured from the
// offsetParent's border-box origin INCLUDING that parent's padding — so the
// marker offsets already carry the copied padding, and only the TEXTAREA'S
// OWN border needs adding back when mapping into viewport space. Scroll is
// subtracted because the marker tracks layout, not the scrolled view.
function measureCaret(textarea: HTMLTextAreaElement): {
  x: number;
  y: number;
  viewportX: number;
  viewportY: number;
  lineHeight: number;
} | null {
  let mirror = document.getElementById("mention-caret-mirror") as HTMLDivElement | null;
  if (!mirror) {
    mirror = document.createElement("div");
    mirror.id = "mention-caret-mirror";
    document.body.appendChild(mirror);
  }
  const style = window.getComputedStyle(textarea);
  Object.assign(mirror.style, {
    position: "absolute",
    visibility: "hidden",
    whiteSpace: "pre-wrap",
    wordWrap: "break-word",
    boxSizing: "content-box",
    width: `${textarea.clientWidth}px`,
    font: style.font,
    lineHeight: style.lineHeight,
    letterSpacing: style.letterSpacing,
    padding: style.padding,
    border: "none",
  });
  const caret = textarea.selectionStart ?? 0;
  mirror.textContent = textarea.value.slice(0, caret);
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  mirror.appendChild(marker);

  const lineHeight = parseInt(style.lineHeight || "20", 10) || 20;
  const borderTop = parseFloat(style.borderTopWidth) || 0;
  const borderLeft = parseFloat(style.borderLeftWidth) || 0;
  const rect = textarea.getBoundingClientRect();
  const viewportX =
    rect.left + borderLeft + marker.offsetLeft - textarea.scrollLeft;
  const viewportY =
    rect.top + borderTop + marker.offsetTop - textarea.scrollTop;

  // Viewport → container-relative (positioned ancestor of the textarea).
  const container = textarea.offsetParent as HTMLElement | null;
  const containerRect = container
    ? container.getBoundingClientRect()
    : { left: 0, top: 0 };
  return {
    x: viewportX - containerRect.left,
    y: viewportY - containerRect.top,
    viewportX,
    viewportY,
    lineHeight,
  };
}

function computePopupStyle(textarea: HTMLTextAreaElement, itemCount: number): CSSProperties | null {
  const caret = measureCaret(textarea);
  if (!caret) return null;
  const placement = positionPopup({
    caretX: caret.x,
    caretContainerY: caret.y,
    caretViewportY: caret.viewportY,
    caretLineHeight: caret.lineHeight,
    popupWidth: POPUP_WIDTH,
    popupHeight: estimatePopupHeight(itemCount),
    containerWidth: (textarea.offsetParent as HTMLElement | null)?.clientWidth ?? window.innerWidth,
  });
  return {
    position: "absolute",
    left: placement.left,
    top: placement.top,
    width: POPUP_WIDTH,
    maxHeight: POPUP_MAX_HEIGHT,
    zIndex: 60,
  };
}

interface UseMentionTokensOptions {
  slug: string;
  value: string;
  onChange: (next: string) => void;
  debounceMs?: number | undefined;
  fetchItems?: typeof fetchMentionItems;
}

export function useMentionTokens({ slug, value, onChange, debounceMs = 150, fetchItems = fetchMentionItems }: UseMentionTokensOptions) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<MentionItem[]>([]);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [popupStyle, setPopupStyle] = useState<CSSProperties | null>(null);

  const triggerRef = useRef<{ query: string; start: number } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const debounceRef = useRef<number | null>(null);
  const fetchSeq = useRef(0);

  const close = useCallback(() => {
    triggerRef.current = null;
    setOpen(false);
    setItems([]);
    setFocusedIndex(0);
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  }, []);

  useEffect(() => close, [close]);

  // Recompute placement while the popup is open — resize and scroll move the
  // caret anchor under it.
  useEffect(() => {
    if (!open) return;
    const recompute = () => {
      const el = textareaRef.current;
      if (el) setPopupStyle(computePopupStyle(el, items.length));
    };
    window.addEventListener("resize", recompute);
    window.addEventListener("scroll", recompute, true);
    return () => {
      window.removeEventListener("resize", recompute);
      window.removeEventListener("scroll", recompute, true);
    };
  }, [open, items.length]);

  const evaluate = useCallback(
    (textarea: HTMLTextAreaElement) => {
      const caret = textarea.selectionStart ?? textarea.value.length;
      const trigger = findActiveTrigger(textarea.value, caret);
      if (!trigger) {
        close();
        return;
      }
      triggerRef.current = trigger;
      textareaRef.current = textarea;
      setPopupStyle(computePopupStyle(textarea, items.length));
      if (!isValidMentionQuery(trigger.query)) {
        setItems([]);
        setOpen(true);
        return;
      }
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
      const seq = ++fetchSeq.current;
      debounceRef.current = window.setTimeout(() => {
        void fetchItems(slug, trigger.query).then((rows) => {
          if (seq !== fetchSeq.current) return;
          setItems(rows);
          setFocusedIndex(0);
          setOpen(true);
          // Height estimate changed with the real item count — re-place.
          if (textareaRef.current) setPopupStyle(computePopupStyle(textareaRef.current, rows.length));
        });
      }, debounceMs);
      setOpen(true);
    },
    [close, debounceMs, fetchItems, items.length, slug]
  );

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      onChange(event.target.value);
      evaluate(event.target);
    },
    [evaluate, onChange]
  );

  const handleSelect = useCallback(
    (textarea: HTMLTextAreaElement | null) => {
      const trigger = triggerRef.current;
      const item = items[focusedIndex];
      if (!trigger || !item || !textarea) return;
      const token = item.refType === "task" ? item.label : item.sublabel;
      const next = applyCompletion(textarea.value, textarea.selectionStart ?? textarea.value.length, trigger.start, token);
      onChange(next.value);
      close();
      requestAnimationFrame(() => {
        textarea.focus();
        textarea.setSelectionRange(next.caret, next.caret);
      });
    },
    [close, focusedIndex, items, onChange]
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!open) return false;
      if (event.key === "ArrowDown" && items.length > 0) {
        event.preventDefault();
        setFocusedIndex((i) => (i + 1) % items.length);
        return true;
      }
      if (event.key === "ArrowUp" && items.length > 0) {
        event.preventDefault();
        setFocusedIndex((i) => (i - 1 + items.length) % items.length);
        return true;
      }
      if (event.key === "Enter") {
        if (items.length === 0) {
          close();
          return false;
        }
        event.preventDefault();
        handleSelect(event.currentTarget);
        return true;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return true;
      }
      return false;
    },
    [close, handleSelect, items.length, open]
  );

  // Re-evaluate on caret moves without text changes (arrows in the middle of
  // an active trigger keep or close the popup).
  const handleSelectCaret = useCallback(
    (event: React.SyntheticEvent<HTMLTextAreaElement>) => {
      const textarea = event.currentTarget;
      const trigger = findActiveTrigger(textarea.value, textarea.selectionStart ?? 0);
      if (!trigger && open) close();
    },
    [close, open]
  );

  return { open, items, focusedIndex, popupStyle, handleChange, handleKeyDown, handleSelect, handleSelectCaret, close };
}
