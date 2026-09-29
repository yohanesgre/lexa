import { describe, expect, it } from "vitest";
import {
  ASSISTANT_WRITE_INTENT_RE,
  hasAssistantWriteIntent,
  modelOptionsWithWriteIntent,
} from "./assistant-helpers";
import { WRITE_INTENT_RE } from "../assistant/build-stream";

const positives = [
  "can you remove all tasks?",
  "delete task X",
  "please remove the task",
  "hapus semua task",
  "create a milestone called v2",
  "tambah sprint",
  "update the wiki page",
];

const negatives = [
  "how many tasks are there?",
  "what tasks are in the backlog?",
  "what is the status of the wiki page?",
  "show me the board",
  "",
];

describe("assistant write intent", () => {
  it("matches delete/remove phrasing in both single-sourced regexes", () => {
    for (const message of positives) {
      expect(hasAssistantWriteIntent(message), message).toBe(true);
      expect(WRITE_INTENT_RE.test(message), message).toBe(true);
    }
  });

  it("does not match read-only questions", () => {
    for (const message of negatives) {
      expect(hasAssistantWriteIntent(message), message).toBe(false);
      expect(WRITE_INTENT_RE.test(message), message).toBe(false);
    }
  });

  it("single-sources the build-stream guard regex with the gating regex", () => {
    expect(WRITE_INTENT_RE).toBe(ASSISTANT_WRITE_INTENT_RE);
  });

  it("requires a tool call only when writes are enabled and intent matches", () => {
    expect(modelOptionsWithWriteIntent(undefined, "can you remove all tasks?", ["delete_task"]))
      .toEqual({ tool_choice: "required" });
    expect(modelOptionsWithWriteIntent({ reasoning_effort: "low" }, "delete task X", ["delete_task"]))
      .toEqual({ reasoning_effort: "low", tool_choice: "required" });
    expect(modelOptionsWithWriteIntent(undefined, "how many tasks are there?", ["delete_task"]))
      .toBeUndefined();
    expect(modelOptionsWithWriteIntent(undefined, "can you remove all tasks?", []))
      .toBeUndefined();
  });
});
