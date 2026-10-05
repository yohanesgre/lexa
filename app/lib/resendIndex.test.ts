import { describe, expect, it } from "vitest";
import { rawMessageText, rawRoleAt, rawUserIndexByText, resolveRawUserIndex } from "./resendIndex";

// LX-124: the split persists a zero-text `data-continuation` boundary marker and
// a text-only continuation as assistant messages. Resend targeting keys on
// role+text and must never latch onto either assistant message.

const user = (text: string) => ({ role: "user", parts: [{ type: "text", text }] });
const boundary = (batchId: string) => ({
  role: "assistant",
  parts: [{ type: "data-continuation", data: { batchId, ts: "2026-01-01T00:00:00Z" } }],
});
const continuation = (text: string) => ({ role: "assistant", parts: [{ type: "text", text }] });

const splitTranscript = [
  user("go"),
  { role: "assistant", parts: [{ type: "data-assistant-approval", data: { batchId: "b1", approvals: [] } }] },
  boundary("b1"),
  continuation("Done — nothing ran."),
];

describe("resendIndex — LX-124 continuation boundary", () => {
  it("reads the marker as an assistant message with no text", () => {
    expect(rawRoleAt(splitTranscript, 2)).toBe("assistant");
    expect(rawMessageText(splitTranscript[2])).toBe("");
  });

  it("never maps a resend target onto the boundary or continuation", () => {
    expect(rawUserIndexByText(splitTranscript, "")).toBeNull();
    expect(resolveRawUserIndex(splitTranscript, { rawIndex: 2, text: "" }, 0)).toBeNull();
    expect(resolveRawUserIndex(splitTranscript, { rawIndex: 3, text: "Done — nothing ran." }, 0)).toBeNull();
  });

  it("still resolves the user turn by role+text across the split", () => {
    expect(resolveRawUserIndex(splitTranscript, { rawIndex: 0, text: "go" }, 0)).toBe(0);
    expect(resolveRawUserIndex(splitTranscript, { rawIndex: -1, text: "go" }, 0)).toBe(0);
  });

  it("ignores an assistant marker when locating a later identical user prompt", () => {
    const messages = [user("same"), boundary("b1"), continuation("x"), user("same")];
    expect(rawUserIndexByText(messages, "same", 0)).toBe(3);
    expect(rawUserIndexByText(messages, "same", 2)).toBe(3);
  });
});
