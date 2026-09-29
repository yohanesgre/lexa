// @vitest-environment jsdom
// Assistant panel phase rendering (herald-popover.html States 1–7): one branch
// per stream phase, plus the settings-error state and the Done result labels.
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ComponentProps } from "react";
import type { Editor } from "@tiptap/core";
import { AssistantPanelBody } from "./AssistantPanelBody";

vi.mock("@tanstack/react-router", () => ({
  Link: (props: { children?: React.ReactNode }) => <a href="#settings">{props.children}</a>,
}));

type BodyProps = ComponentProps<typeof AssistantPanelBody>;

const editor = {} as Editor;

function stream(overrides: Record<string, unknown> = {}): BodyProps["stream"] {
  return {
    status: "idle",
    frames: [],
    text: "",
    tools: [],
    items: [],
    reasoningText: "",
    reasoningActive: false,
    reasoningMs: null,
    pending: [],
    suspendedBatchId: null,
    error: null,
    usage: null,
    hasIngress: false,
    send: vi.fn(),
    abort: vi.fn(),
    reset: vi.fn(),
    subscribe: vi.fn(),
    getSnapshot: vi.fn(),
    ...overrides,
  } as unknown as BodyProps["stream"];
}

function renderBody(overrides: Partial<BodyProps> = {}) {
  return render(
    <AssistantPanelBody
      stream={stream()}
      providerMissing={false}
      settingsError={false}
      onRetrySettings={vi.fn()}
      projectId="p1"
      documentTitle="Doc"
      skillName="Requirements"
      providerLabel="gpt"
      taskId={null}
      appliedTaskId={null}
      rejectedTaskId={null}
      reviewActive={false}
      onReview={vi.fn()}
      onRetry={vi.fn()}
      onStop={vi.fn()}
      onDismiss={vi.fn()}
      editor={editor}
      onClose={vi.fn()}
      {...overrides}
    >
      <div data-testid="idle-form" />
    </AssistantPanelBody>
  );
}

describe("AssistantPanelBody", () => {
  it("renders the provider-missing empty state", () => {
    renderBody({ providerMissing: true });
    expect(screen.getByText("No AI provider configured")).toBeInTheDocument();
    expect(screen.queryByTestId("idle-form")).not.toBeInTheDocument();
  });

  it("renders a retryable settings-error state instead of a dead form", () => {
    const onRetrySettings = vi.fn();
    renderBody({ settingsError: true, onRetrySettings });
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load Assistant settings");
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    expect(onRetrySettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("idle-form")).not.toBeInTheDocument();
  });

  it("renders the streaming preview and Stop; tools heading only once a chip exists", () => {
    renderBody({ stream: stream({ status: "streaming", text: "partial" }) });
    expect(screen.getByText("partial")).toBeInTheDocument();
    expect(screen.queryByText("Tools")).not.toBeInTheDocument();

    renderBody({
      stream: stream({ status: "streaming", text: "partial", tools: [{ key: "t1", name: "web_search", label: "Searching web…", phase: "call" }] }),
    });
    expect(screen.getByText("Tools")).toBeInTheDocument();
    expect(screen.getByText("Searching web…")).toBeInTheDocument();
  });

  it("renders the done view with Review in editor", () => {
    renderBody({ stream: stream({ status: "done", text: "result" }), taskId: "t1" });
    expect(screen.getByRole("button", { name: /Review in editor/ })).toBeInTheDocument();
  });

  it("labels applied, rejected, and in-review results distinctly", () => {
    renderBody({ stream: stream({ status: "done", text: "result" }), taskId: "t1", reviewActive: true });
    expect(screen.getByText("In review in editor")).toBeInTheDocument();

    renderBody({ stream: stream({ status: "done", text: "result" }), taskId: "t1", appliedTaskId: "t1" });
    expect(screen.getByText("Applied to document")).toBeInTheDocument();

    renderBody({ stream: stream({ status: "done", text: "result" }), taskId: "t1", rejectedTaskId: "t1" });
    expect(screen.getByText("Result rejected")).toBeInTheDocument();
  });

  it("renders the failed state with code, message, and Retry", () => {
    renderBody({
      stream: stream({ status: "error", error: { code: "ASSISTANT_GENERATION_FAILED", message: "boom" } }),
    });
    expect(screen.getByRole("alert")).toHaveTextContent("ASSISTANT_GENERATION_FAILED");
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry/ })).toBeInTheDocument();
  });
});
