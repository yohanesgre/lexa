import { describe, expect, it } from "vitest";
import { resendIndex } from "./resendIndex";

// Transcript entries as the wire carries them: role + content, optional
// inline meta. Legacy entries carry no meta at all.
const u = (content: unknown) => ({ role: "user", content });
const a = (content: string) => ({ role: "assistant", content });

describe("resendIndex", () => {
  it("edit returns the edited user entry's raw index", () => {
    const messages = [u("first"), a("reply"), u("second"), a("reply2")];
    expect(resendIndex(messages, "edit", 2)).toBe(2);
  });

  it("edit rejects targets that are not user entries or out of range", () => {
    const messages = [u("first"), a("reply")];
    expect(resendIndex(messages, "edit", 1)).toBeNull();
    expect(resendIndex(messages, "edit", 2)).toBeNull();
    expect(resendIndex(messages, "edit", -1)).toBeNull();
    expect(resendIndex(messages, "edit", undefined)).toBeNull();
  });

  it("regenerate/retry return the LAST user entry index", () => {
    const messages = [u("first"), a("reply"), u("second"), a("partial"), { role: "assistant", stopped: true }];
    expect(resendIndex(messages, "regenerate")).toBe(2);
    expect(resendIndex(messages, "retry")).toBe(2);
  });

  it("counts legacy entries without meta and image-only parts as positions", () => {
    const messages = [
      u("plain"),
      // assistant entry with an image part + text — still one position
      { role: "assistant", content: [{ type: "image-ref" }, { text: "caption" }] },
      // image-only user entry — position counts even without text
      u([{ type: "image-ref" }, { type: "image-ref" }]),
      u("latest"),
      a("ok"),
    ];
    expect(resendIndex(messages, "edit", 3)).toBe(3);
    expect(resendIndex(messages, "regenerate")).toBe(3);
  });

  it("skips non-user/assistant roles when scanning", () => {
    const messages = [{ role: "system", content: "sys" }, u("hello"), a("hi"), { role: "tool", content: "x" }];
    expect(resendIndex(messages, "retry")).toBe(1);
  });

  it("returns null on empty threads or threads without user turns", () => {
    expect(resendIndex([], "regenerate")).toBeNull();
    expect(resendIndex([a("only reply")], "retry")).toBeNull();
  });
});
