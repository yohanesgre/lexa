import { describe, expect, it } from "vitest";
import { classifyLogLine } from "./forge-log";

describe("classifyLogLine", () => {
  it("classifies stdout as info always", () => {
    expect(classifyLogLine("out", "generated draft")).toEqual({ level: "info" });
    expect(classifyLogLine("out", "fatal: something on stdout")).toEqual({ level: "info" });
  });

  it("flags error-like stderr lines", () => {
    for (const msg of [
      "model request failed, retrying...",
      "ERROR: could not reach the provider",
      "connection refused by api.example.com",
      "unable to load config",
      "TimeoutError: request took too long",
      "fatal error: out of memory",
      "access denied for model",
      "[stderr] model request failed, retrying...",
    ]) {
      expect(classifyLogLine("err", msg)).toEqual({ level: "error" });
    }
  });

  it("flags warn-like stderr lines (retries, rate limits, backoffs)", () => {
    for (const msg of [
      "rate limit hit, retrying in 5s...",
      "retrying request (attempt 2)",
      "backing off due to 429",
      "warning: deprecated flag --model",
      "provider unavailable, using fallback",
    ]) {
      expect(classifyLogLine("err", msg)).toEqual({ level: "warn" });
    }
  });

  it("does not match bare words inside filenames/prose (real opencode output)", () => {
    for (const msg of [
      "-rw-r--r-- 1 yohanes yohanes 1016 Aug 4 14:34 warn.txt",
      "skip: cached entry (no changes)",
      "context window limit reached (128k)",
      "slow response from provider, continuing",
    ]) {
      expect(classifyLogLine("err", msg)).toEqual({ level: "info" });
    }
  });

  it("keeps non-error stderr chatter neutral", () => {
    for (const msg of [
      "token usage: 2.1k in, 340 out",
      "spinner: running tool call",
      "context window: 128k",
      "model: opencode/deepseek-v4-flash",
      "▸ some stdout-like line on stderr",
    ]) {
      expect(classifyLogLine("err", msg)).toEqual({ level: "info" });
    }
  });

  it("strips legacy markers before matching", () => {
    expect(classifyLogLine("err", "[stderr] fatal error")).toEqual({ level: "error" });
    expect(classifyLogLine("err", "▸ retrying")).toEqual({ level: "warn" });
  });
});
