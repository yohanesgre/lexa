// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { copyToClipboard } from "./clipboard";

describe("copyToClipboard", () => {
  const originalClipboard = navigator.clipboard;
  const originalExecCommand = document.execCommand;

  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    document.execCommand = (() => false) as typeof document.execCommand;
  });

  afterEach(() => {
    Object.defineProperty(navigator, "clipboard", { value: originalClipboard, configurable: true });
    document.execCommand = originalExecCommand;
  });

  it("uses navigator.clipboard.writeText when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await expect(copyToClipboard("hello")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to execCommand when writeText rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    document.execCommand = (() => true) as typeof document.execCommand;
    await expect(copyToClipboard("hello")).resolves.toBe(true);
  });

  it("falls back to execCommand when navigator.clipboard is undefined", async () => {
    let captured = "";
    const spy = vi.fn((cmd: string) => {
      if (cmd === "copy") {
        const ta = document.querySelector("textarea") as HTMLTextAreaElement | null;
        captured = ta?.value ?? "";
        return true;
      }
      return false;
    }) as typeof document.execCommand;
    document.execCommand = spy;
    await expect(copyToClipboard("fallback text")).resolves.toBe(true);
    expect(spy).toHaveBeenCalledWith("copy");
    expect(captured).toBe("fallback text");
    // The hidden textarea is removed after the copy.
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("returns false when both paths fail", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    document.execCommand = (() => { throw new Error("not implemented"); }) as typeof document.execCommand;
    await expect(copyToClipboard("hello")).resolves.toBe(false);
  });

  it("returns false when clipboard is undefined and execCommand throws", async () => {
    document.execCommand = (() => { throw new Error("not implemented"); }) as typeof document.execCommand;
    await expect(copyToClipboard("hello")).resolves.toBe(false);
  });
});
