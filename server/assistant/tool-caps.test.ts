import { describe, expect, it } from "vitest";
import { MAX_CHAT_TOOL_ROUNDS, MAX_RUNNER_STEPS, MAX_TOOL_ROUNDS, runnerStopWhen } from "./tool-caps";

describe("tool caps", () => {
  it("keeps the regular-turn caps at 12/24 and sets the runner cap to 16", () => {
    expect(MAX_TOOL_ROUNDS).toBe(12);
    expect(MAX_CHAT_TOOL_ROUNDS).toBe(24);
    expect(MAX_RUNNER_STEPS).toBe(16);
  });

  it("runnerStopWhen stops at 16 steps, not before", () => {
    const [stop] = runnerStopWhen();
    const step = (n: number) => ({ steps: Array.from({ length: n }, () => ({})) }) as never;
    expect(stop!(step(15))).toBe(false);
    expect(stop!(step(16))).toBe(true);
  });
});
