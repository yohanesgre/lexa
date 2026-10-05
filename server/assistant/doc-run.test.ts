import { describe, expect, it } from "vitest";
import { buildDocumentRunInstruction, buildDocumentRunStopWhen, resolveDocumentRunPermissionMode } from "./doc-run";

describe("buildDocumentRunInstruction", () => {
  it("quotes a non-blank selection and appends the extra prompt", () => {
    expect(buildDocumentRunInstruction("hello world", "polish this")).toBe(
      'Selected text:\n"""\nhello world\n"""\n\npolish this'
    );
  });

  it("drops a blank selection and trims-empty extra prompt", () => {
    expect(buildDocumentRunInstruction("   ", "make it short")).toBe("make it short");
    expect(buildDocumentRunInstruction("", "")).toBe("");
    expect(buildDocumentRunInstruction(null, "  ")).toBe("");
    expect(buildDocumentRunInstruction(undefined, undefined)).toBe("");
  });

  it("keeps the selection when there is no extra prompt", () => {
    expect(buildDocumentRunInstruction("only selection", "")).toBe(
      'Selected text:\n"""\nonly selection\n"""'
    );
  });
});

describe("resolveDocumentRunPermissionMode", () => {
  it("is always ask (the picker is chat-only)", () => {
    expect(resolveDocumentRunPermissionMode()).toBe("ask");
  });
});

describe("buildDocumentRunStopWhen", () => {
  type Condition = (options: { steps: Array<{ toolResults: Array<{ toolName: string; output: unknown }> }> }) => boolean | Promise<boolean>;

  it("always includes the tool-round cap", () => {
    const conditions = buildDocumentRunStopWhen({ toolRoundCap: 3, permissionMode: "ask", enabledWrite: [] });
    expect(conditions).toHaveLength(1);
    const cap = conditions[0] as unknown as Condition;
    expect(cap({ steps: [] })).toBe(false);
    expect(cap({ steps: [{ toolResults: [] }, { toolResults: [] }, { toolResults: [] }] })).toBe(true);
  });

  it("adds the write-suspend condition only when write tools are enabled", () => {
    const withWrites = buildDocumentRunStopWhen({ toolRoundCap: 3, permissionMode: "ask", enabledWrite: ["update_task"] });
    expect(withWrites).toHaveLength(2);
    const suspend = withWrites[1] as unknown as Condition;
    const proposed = [{ toolResults: [{ toolName: "update_task", output: { proposed: true } }] }];
    expect(suspend({ steps: proposed })).toBe(true);
    expect(suspend({ steps: [{ toolResults: [{ toolName: "update_task", output: { proposed: false } }] }] })).toBe(false);

    const noWrites = buildDocumentRunStopWhen({ toolRoundCap: 3, permissionMode: "ask", enabledWrite: [] });
    expect(noWrites).toHaveLength(1);
  });

  it("never suspends outside ask mode", () => {
    const conditions = buildDocumentRunStopWhen({ toolRoundCap: 3, permissionMode: "auto", enabledWrite: ["update_task"] });
    const suspend = conditions[1] as unknown as Condition;
    expect(suspend({ steps: [{ toolResults: [{ toolName: "update_task", output: { proposed: true } }] }] })).toBe(false);
  });
});
