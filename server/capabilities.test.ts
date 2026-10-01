import { describe, expect, it } from "vitest";
import { capabilities, capabilitiesFromRuntimeEnv, chatAttachmentsEnabled, hasSecretsMasterKey } from "./capabilities";
import type { RuntimeEnv } from "./env";

const KEY = Buffer.from("k".repeat(32)).toString("base64");

describe("hasSecretsMasterKey", () => {
  it("requires a non-empty key", () => {
    expect(hasSecretsMasterKey({})).toBe(false);
    expect(hasSecretsMasterKey({ LXK_SECRETS_MASTER_KEY: "" })).toBe(false);
    expect(hasSecretsMasterKey({ LXK_SECRETS_MASTER_KEY: KEY })).toBe(true);
  });
});

describe("chatAttachmentsEnabled (kill switch)", () => {
  it("is enabled by default and for every value except exactly '1'", () => {
    expect(chatAttachmentsEnabled({})).toBe(true);
    expect(chatAttachmentsEnabled({ LXK_DISABLE_CHAT_ATTACHMENTS: "0" })).toBe(true);
    expect(chatAttachmentsEnabled({ LXK_DISABLE_CHAT_ATTACHMENTS: "true" })).toBe(true);
    expect(chatAttachmentsEnabled({ LXK_DISABLE_CHAT_ATTACHMENTS: "" })).toBe(true);
  });

  it("is disabled only when set to exactly '1'", () => {
    expect(chatAttachmentsEnabled({ LXK_DISABLE_CHAT_ATTACHMENTS: "1" })).toBe(false);
  });
});

describe("capabilities (GET /api/capabilities)", () => {
  it("bun flavor always reports assistant:false and chatAttachments:false", () => {
    expect(capabilities("bun", {})).toEqual({ assistant: false, flavor: "bun", chatAttachments: false });
    // The master key and the kill switch cannot make the Bun host offer a
    // Workers-only feature.
    expect(capabilities("bun", { LXK_SECRETS_MASTER_KEY: KEY })).toEqual({
      assistant: false,
      flavor: "bun",
      chatAttachments: false,
    });
  });

  it("workers flavor needs the master key; chatAttachments follows the kill switch", () => {
    expect(capabilities("workers", {})).toEqual({ assistant: false, flavor: "workers", chatAttachments: false });
    expect(capabilities("workers", { LXK_SECRETS_MASTER_KEY: KEY })).toEqual({
      assistant: true,
      flavor: "workers",
      chatAttachments: true,
    });
    expect(capabilities("workers", { LXK_SECRETS_MASTER_KEY: KEY, LXK_DISABLE_CHAT_ATTACHMENTS: "1" })).toEqual({
      assistant: true,
      flavor: "workers",
      chatAttachments: false,
    });
  });

  it("capabilitiesFromRuntimeEnv delegates with the same result", () => {
    const env = { LXK_SECRETS_MASTER_KEY: KEY } as RuntimeEnv;
    expect(capabilitiesFromRuntimeEnv("workers", env)).toEqual(capabilities("workers", env));
  });
});
