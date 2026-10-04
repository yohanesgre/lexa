// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const seedSampleData = vi.hoisted(() => vi.fn());
const completeSetup = vi.hoisted(() => vi.fn());

vi.mock("../../lib/api", () => ({
  seedSampleData,
  completeSetup,
}));

import { SetupStepSeed } from "./SetupStepSeed";

beforeEach(() => {
  seedSampleData.mockReset();
  completeSetup.mockReset();
});

describe("SetupStepSeed", () => {
  it("surfaces a seed failure and does not advance", async () => {
    seedSampleData.mockRejectedValue(new Error("database locked"));
    const onDone = vi.fn();
    render(<SetupStepSeed onDone={onDone} onBack={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /Finish setup/ }));

    expect(await screen.findByText("database locked")).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    expect(completeSetup).not.toHaveBeenCalled();
  });

  it("completes setup and advances on success", async () => {
    seedSampleData.mockResolvedValue(undefined);
    completeSetup.mockResolvedValue(undefined);
    const onDone = vi.fn();
    render(<SetupStepSeed onDone={onDone} onBack={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /Finish setup/ }));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(seedSampleData).toHaveBeenCalledWith("minimal");
    expect(completeSetup).toHaveBeenCalledTimes(1);
  });

  it("moves the radio selection with arrow keys", () => {
    render(<SetupStepSeed onDone={vi.fn()} onBack={vi.fn()} />);
    const group = screen.getByRole("radiogroup");

    expect(screen.getByRole("radio", { name: /Minimal/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(group, { key: "ArrowDown" });
    expect(screen.getByRole("radio", { name: /Full/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(group, { key: "ArrowUp" });
    expect(screen.getByRole("radio", { name: /Minimal/ })).toHaveAttribute("aria-checked", "true");
  });
});
