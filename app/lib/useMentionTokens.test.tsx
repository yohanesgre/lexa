// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { MentionItem } from "./mention-suggestion";
import { applyCompletion, findActiveTrigger, positionPopup, useMentionTokens } from "./useMentionTokens";

const ITEMS: MentionItem[] = [
  { refType: "task", refId: "t1", label: "NIM-231", sublabel: "Reconciliation job retries" },
  { refType: "wiki", refId: "payments-migration", label: "Payments Migration Runbook", sublabel: "payments-migration" },
];

function textarea(): HTMLTextAreaElement {
  const el = document.createElement("textarea");
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("findActiveTrigger / applyCompletion (pure)", () => {
  it("triggers only at a word boundary and captures the query", () => {
    expect(findActiveTrigger("see @rec", 8)).toEqual({ query: "rec", start: 4 });
    expect(findActiveTrigger("@rec", 4)).toEqual({ query: "rec", start: 0 });
    expect(findActiveTrigger("email@example", 13)).toBeNull(); // no boundary before @
    expect(findActiveTrigger("done @rec done", 14)).toBeNull(); // trigger closed by space
  });

  it("replaces the query with the token + trailing space at the caret", () => {
    // caret sits after the last query char ("@pay" spans 10..13, caret = 14)
    const next = applyCompletion("fold into @pay now", 14, 10, "payments-migration");
    // Existing whitespace after the caret → no extra separator added.
    expect(next.value).toBe("fold into @payments-migration now");
    expect(next.caret).toBe(29);
  });
});

describe("positionPopup (pure placement math — flip decided in VIEWPORT space)", () => {
  const base = {
    caretX: 120,
    caretContainerY: 200,
    caretViewportY: 300,
    caretLineHeight: 20,
    popupWidth: 360,
    popupHeight: 150,
    containerWidth: 760,
  };

  it("anchors directly above the caret with the gap (container-space top)", () => {
    expect(positionPopup(base)).toEqual({ left: 120, top: 44, flipped: false }); // 200 - 150 - 6
  });

  it("REGRESSION: caret near the TOP OF ITS BOX stays ABOVE when the viewport has room", () => {
    // Line-1 caret: container-relative y ≈ padding (~12px) but viewport y is mid-page.
    const out = positionPopup({ ...base, caretContainerY: 12, caretViewportY: 400 });
    expect(out.flipped).toBe(false);
    expect(out.top).toBe(12 - 150 - 6); // negative container top = floats above the box
  });

  it("flips below ONLY on genuine viewport-room failure", () => {
    const out = positionPopup({ ...base, caretViewportY: 100 }); // 100 < 150 + 6
    expect(out.flipped).toBe(true);
    expect(out.top).toBe(200 + 20 + 6); // container caretY + lineHeight + gap
  });

  it("clamps horizontally to the container bounds on both sides", () => {
    expect(positionPopup({ ...base, caretX: -40 }).left).toBe(0);
    expect(positionPopup({ ...base, caretX: 900 }).left).toBe(400); // 760 - 360
    expect(positionPopup({ ...base, caretX: 300 }).left).toBe(300); // unclamped
  });
});

describe("useMentionTokens", () => {
  const fetchItems = vi.fn().mockResolvedValue(ITEMS);
  const setup = () => {
    let value = "";
    const onChange = (next: string) => { value = next; };
    const rendered = renderHook(() =>
      useMentionTokens({ slug: "nimbus", value, onChange, debounceMs: 10, fetchItems })
    );
    const el = textarea();
    return { ...rendered, el, getValue: () => value };
  };

  function type(hook: ReturnType<typeof setup>, text: string) {
    hook.el.value = text;
    hook.el.selectionStart = text.length;
    act(() => hook.result.current.handleChange({ target: hook.el } as unknown as React.ChangeEvent<HTMLTextAreaElement>));
  }

  it("opens on @, debounces the fetch, exposes split items", async () => {
    const hook = setup();
    type(hook, "around @pay");
    expect(fetchItems).not.toHaveBeenCalled(); // debounced
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(fetchItems).toHaveBeenCalledWith("nimbus", "pay");
    expect(hook.result.current.open).toBe(true);
    expect(hook.result.current.items).toHaveLength(2);
    expect(hook.result.current.focusedIndex).toBe(0);
  });

  it("keyboard: ↓/↑ move focus, Enter completes into the value at the caret, Esc closes", async () => {
    const hook = setup();
    type(hook, "see @rec");
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });

    const key = (key: string) =>
      act(() => hook.result.current.handleKeyDown({ key, preventDefault: () => {}, currentTarget: hook.el } as React.KeyboardEvent<HTMLTextAreaElement>));

    key("ArrowDown");
    expect(hook.result.current.focusedIndex).toBe(1);
    key("ArrowUp");
    expect(hook.result.current.focusedIndex).toBe(0);

    hook.el.value = "see @rec";
    hook.el.selectionStart = 8;
    const enterEvent = { key: "Enter", preventDefault: () => {}, currentTarget: hook.el } as React.KeyboardEvent<HTMLTextAreaElement>;
    let consumed = false;
    act(() => { consumed = hook.result.current.handleKeyDown(enterEvent); });
    expect(consumed).toBe(true);
    expect(hook.getValue()).toBe("see @NIM-231 ");
    expect(hook.result.current.open).toBe(false);

    // Esc closes without inserting.
    type(hook, "x @nope");
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    const esc = { key: "Escape", preventDefault: () => {}, currentTarget: hook.el } as React.KeyboardEvent<HTMLTextAreaElement>;
    act(() => { hook.result.current.handleKeyDown(esc); });
    expect(hook.result.current.open).toBe(false);
    expect(hook.getValue()).toBe("x @nope");
  });

  it("closes when the trigger is deleted or left via whitespace", async () => {
    const hook = setup();
    type(hook, "@abc");
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(hook.result.current.open).toBe(true);
    type(hook, "@abc done");
    expect(hook.result.current.open).toBe(false);
    type(hook, "@ab");
    expect(hook.result.current.open).toBe(true);
  });
});
