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
});
