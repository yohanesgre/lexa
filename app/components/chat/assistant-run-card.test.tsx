// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AssistantRunCard } from "./AssistantRunCard";
import { RUN_LOG_REPLAY_BOUNDARY, type RunCardModel } from "../../lib/assistant-run-adapter";

function model(overrides: Partial<RunCardModel> = {}): RunCardModel {
  return {
    runId: "run_8f3c2a91",
    goal: "Polish the release runbook",
    state: "running",
    stepsUsed: 9,
    result: null,
    error: null,
    autoWrites: 0,
    events: [],
    live: true,
    mode: null,
    ...overrides,
  };
}

describe("AssistantRunCard", () => {
  it("renders the dispatching state with an indeterminate bar", () => {
    const { container } = render(<AssistantRunCard model={model({ state: "dispatching", stepsUsed: 0 })} onAbort={() => {}} />);
    expect(screen.getByText("Dispatching")).toBeTruthy();
    expect(screen.getByText("starting…")).toBeTruthy();
    expect(container.querySelector(".run-card.state-queued")).toBeTruthy();
    expect(container.querySelector(".run-card-bar.is-indeterminate")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  });

  it("renders the running state with an indeterminate bar (no fabricated progress)", () => {
    const { container } = render(<AssistantRunCard model={model({ state: "running", stepsUsed: 3 })} onAbort={() => {}} />);
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText("step 3")).toBeTruthy();
    expect(container.querySelector(".run-card-bar.is-indeterminate")).toBeTruthy();
  });

  it("renders the done state with the result summary and no Stop", () => {
    const { container } = render(<AssistantRunCard model={model({ state: "done", stepsUsed: 16, result: "Two wiki pages updated." })} onAbort={() => {}} />);
    expect(screen.getByText("Done")).toBeTruthy();
    expect(screen.getByText("16 steps")).toBeTruthy();
    expect(screen.getByText("Two wiki pages updated.")).toBeTruthy();
    expect(container.querySelector(".run-card-bar")).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("renders the failed state with the catalog code and a Retry action", () => {
    const onRetry = vi.fn();
    render(<AssistantRunCard model={model({ state: "failed", stepsUsed: 12, error: "ASSISTANT_RUN_BUDGET_EXCEEDED" })} onRetry={onRetry} />);
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("ASSISTANT_RUN_BUDGET_EXCEEDED")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    expect(onRetry).toHaveBeenCalledWith("Polish the release runbook");
  });

  it("renders the stopped state with the stopped-by-you divider", () => {
    render(<AssistantRunCard model={model({ state: "stopped", stepsUsed: 5 })} />);
    expect(screen.getByText("Stopped")).toBeTruthy();
    expect(screen.getByText("● Stopped by you")).toBeTruthy();
  });

  it("toggles the inline drill-in between Open run and Close run", () => {
    render(<AssistantRunCard model={model({ state: "done", result: "Done." })} />);
    expect(screen.queryByText("run_8f3c2a91")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open run" }));
    expect(screen.getByText("run_8f3c2a91")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Close run/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Close run/ }));
    expect(screen.queryByText("run_8f3c2a91")).toBeNull();
  });

  it("shows the auto-writes line only when a live run applied writes", () => {
    const { rerender } = render(<AssistantRunCard model={model({ state: "done", autoWrites: 2, live: true })} />);
    expect(screen.getByText("Auto — 2 writes applied automatically")).toBeTruthy();
    rerender(<AssistantRunCard model={model({ state: "done", autoWrites: 0, live: true })} />);
    expect(screen.queryByText(/writes applied/)).toBeNull();
    // Persisted-only (reloaded) run: the count is unavailable, never fabricated.
    rerender(<AssistantRunCard model={model({ state: "done", autoWrites: 2, live: false })} />);
    expect(screen.queryByText(/writes applied/)).toBeNull();
  });

  it("streams live event lines and exposes a Hide events toggle", () => {
    render(
      <AssistantRunCard
        model={model({
          state: "running",
          events: [
            { name: "search_wiki", text: "Reading cutover-runbook", auto: false },
            { name: "update_wiki", text: "Added rollback section", auto: true },
          ],
        })}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open run" }));
    expect(screen.getByText("[search_wiki]")).toBeTruthy();
    expect(screen.getByText("· auto-write")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide events" }));
    expect(screen.queryByText("[search_wiki]")).toBeNull();
    expect(screen.getByRole("button", { name: "Show events" })).toBeTruthy();
  });

  it("renders the persisted-columns boundary and never a fabricated log after reload", () => {
    render(<AssistantRunCard model={model({ state: "running", live: false, events: [], stepsUsed: 9 })} />);
    fireEvent.click(screen.getByRole("button", { name: "Open run" }));
    expect(screen.getByText(RUN_LOG_REPLAY_BOUNDARY)).toBeTruthy();
    expect(screen.queryByText(/^\[/)).toBeNull();
  });
});
