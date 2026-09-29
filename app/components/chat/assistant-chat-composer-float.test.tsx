// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { ChatComposerArea } from "./AssistantChatShell";

// Floating composer (assistant-chat.html): the docked composer is taken out of
// the flow (chat-composer-float) with a scrim behind the card; the landing
// composer stays static and in-flow (is-landing), no float class, no scrim.

function renderComposerArea(landing: boolean) {
  return render(
    <main className="chat-shell">
      <ChatComposerArea
        skills={[]}
        busy409={false}
        slug="nimbus"
        streaming={false}
        suspendedLock={false}
        suspendCount={0}
        attachDisabled={false}
        isMobileComposer
        effort=""
        projectEffort={null}
        onEffortChange={() => {}}
        onSend={() => true}
        onAbort={() => {}}
        landing={landing}
      />
    </main>
  );
}

class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];
  readonly callback: ResizeObserverCallback;
  observed: Element[] = [];
  disconnected = false;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ResizeObserverStub.instances.push(this);
  }

  observe(el: Element) {
    this.observed.push(el);
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  trigger() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

function rect(height: number): DOMRect {
  return {
    width: 760,
    height,
    top: 0,
    left: 0,
    right: 760,
    bottom: height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

afterEach(() => {
  ResizeObserverStub.instances = [];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ChatComposerArea — floating composer", () => {
  it("docks: the composer carries chat-composer-float with a scrim child", () => {
    const { container } = renderComposerArea(false);
    const composer = container.querySelector(".chat-composer")!;
    expect(composer.classList.contains("chat-composer-float")).toBe(true);
    expect(composer.classList.contains("is-landing")).toBe(false);
    const scrim = composer.querySelector(".chat-composer-scrim");
    expect(scrim).toBeTruthy();
    expect(scrim!.getAttribute("aria-hidden")).toBe("true");
  });

  it("landing never floats and has no scrim", () => {
    const { container } = renderComposerArea(true);
    const composer = container.querySelector(".chat-composer")!;
    expect(composer.classList.contains("is-landing")).toBe(true);
    expect(composer.classList.contains("chat-composer-float")).toBe(false);
    expect(composer.querySelector(".chat-composer-scrim")).toBeNull();
  });

  it("writes the measured clearance, tracks growth, and cleans up on unmount", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    const measure = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue(rect(200));

    const { container, unmount } = renderComposerArea(false);
    const shell = container.querySelector(".chat-shell") as HTMLElement;
    expect(shell.style.getPropertyValue("--chat-composer-clearance")).toBe("248px");

    const observer = ResizeObserverStub.instances[0]!;
    expect(observer.observed).toEqual([container.querySelector(".chat-composer")]);

    measure.mockReturnValue(rect(300));
    observer.trigger();
    expect(shell.style.getPropertyValue("--chat-composer-clearance")).toBe("348px");

    unmount();
    expect(observer.disconnected).toBe(true);
    expect(shell.style.getPropertyValue("--chat-composer-clearance")).toBe("");
  });
});
