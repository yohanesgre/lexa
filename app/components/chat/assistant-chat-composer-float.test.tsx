// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChatComposerArea } from "./AssistantChatShell";
import { ResizeObserverStub } from "../../test-utils";

// Floating composer (assistant-chat.html): the docked composer is taken out of
// the flow (chat-composer-float) with a scrim behind the card; the landing
// composer stays static and in-flow (is-landing), no float class, no scrim.

function renderComposerArea(landing: boolean, overrides: Partial<Parameters<typeof ChatComposerArea>[0]> = {}) {
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
        {...overrides}
      />
    </main>
  );
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

// herald-chat.html "Connection lost → auto-resume" (ADR-0003 WS1): the socket
// is down while the turn keeps running server-side — a reconnecting banner
// rides above the composer, the composer locks, and the footer shows
// RECONNECTING; after recovery a short-lived RESUMED marker confirms continuity.
describe("ChatComposerArea — transport reconnect states", () => {
  it("shows the reconnect banner and locks the composer while the socket is down", () => {
    const { container } = renderComposerArea(false, { reconnecting: true });
    const banner = container.querySelector(".banner-warning")!;
    expect(banner.getAttribute("role")).toBe("status");
    expect(banner.textContent).toContain("Connection lost — reconnecting… Your reply keeps running on the server.");
    expect(screen.getByText(/RECONNECTING/)).toBeInTheDocument();
    expect((screen.getByLabelText("Message Assistant") as HTMLTextAreaElement).disabled).toBe(true);
  });

  it("shows the short-lived RESUMED marker without locking the composer", () => {
    const { container } = renderComposerArea(false, { resumed: true });
    expect(container.querySelector(".banner-warning")).toBeNull();
    expect(screen.getByText("● RESUMED")).toBeInTheDocument();
    expect(screen.getByText("Reconnected — stream resumed from the last frame.")).toBeInTheDocument();
    expect((screen.getByLabelText("Message Assistant") as HTMLTextAreaElement).disabled).toBe(false);
  });
});
