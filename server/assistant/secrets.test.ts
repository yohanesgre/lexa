import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  SECRETS_MASTER_KEY_BYTES,
  SECRETS_MASTER_KEY_INVALID,
  SECRET_AAD_PREFIXES,
  SECRET_DECRYPT_FAILED,
  SECRET_IV_BYTES,
  SECRET_KEY_ID_ACTIVE,
  SECRET_KEY_ID_PREV,
  decryptSecret,
  encryptSecret,
  keyIdFor,
  keyringFromKeys,
  parseMasterKey,
  secretsKeyringFromEnv,
  secretsManagedEnabled,
  type SecretKeyring,
  type SecretKeyId,
  type SecretScope,
} from "./secrets";

const MODULE_PATH = fileURLToPath(new URL("./secrets.ts", import.meta.url));

// 32 distinct bytes, so no key is all-zeroes and a wrong-key failure can never
// be confused with a degenerate key.
function keyBytes(seed: number): Uint8Array {
  return Uint8Array.from({ length: SECRETS_MASTER_KEY_BYTES }, (_, i) => (seed * 31 + i * 7) % 256);
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function b64url(bytes: Uint8Array): string {
  return b64(bytes).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

const ACTIVE_RAW = b64(keyBytes(3));
const PREV_RAW = b64(keyBytes(11));

// Built through the public keyring constructor, which is how a caller records
// the slot each key occupies — a bare `parseMasterKey` result belongs to no slot.
async function keyring(): Promise<SecretKeyring> {
  return keyringFromKeys(await parseMasterKey(ACTIVE_RAW), await parseMasterKey(PREV_RAW));
}

const TOKEN = "ghp_examplemanagedsecrettoken0123456789";

describe("secrets master key parsing", () => {
  it("imports a 32-byte base64 key as a non-extractable AES-GCM key", async () => {
    const key = await parseMasterKey(ACTIVE_RAW);
    expect(key.type).toBe("secret");
    expect(key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    // extractable: false is a hard property — the raw key must never be
    // exportable back out of the runtime.
    expect(key.extractable).toBe(false);
    expect([...(key.usages as readonly string[])].sort()).toEqual(["decrypt", "encrypt"]);
  });

  it("accepts base64url and tolerates surrounding whitespace", async () => {
    const key = await parseMasterKey(`  ${b64url(keyBytes(3))}\n`);
    expect(key.algorithm).toMatchObject({ name: "AES-GCM" });
  });

  it("rejects an empty or absent key with the fixed message", async () => {
    await expect(parseMasterKey("")).rejects.toThrow(SECRETS_MASTER_KEY_INVALID);
    await expect(parseMasterKey("   ")).rejects.toThrow(SECRETS_MASTER_KEY_INVALID);
    await expect(parseMasterKey(null)).rejects.toThrow(SECRETS_MASTER_KEY_INVALID);
    await expect(parseMasterKey(undefined)).rejects.toThrow(SECRETS_MASTER_KEY_INVALID);
  });

  it("rejects a short key, a long key, and non-base64 garbage", async () => {
    await expect(parseMasterKey(b64(keyBytes(3).slice(0, 31)))).rejects.toThrow(SECRETS_MASTER_KEY_INVALID);
    await expect(parseMasterKey(b64(new Uint8Array(33).fill(1)))).rejects.toThrow(SECRETS_MASTER_KEY_INVALID);
    // Right base64 length, wrong decoded size: 44 chars decode to 33 bytes, so
    // the decoded-length check (not just the string length) has to catch it.
    await expect(parseMasterKey("A".repeat(44))).rejects.toThrow(SECRETS_MASTER_KEY_INVALID);
    // 32 chars decode to 24 bytes — a plausible-looking but wrong-size key.
    await expect(parseMasterKey("0123456789abcdef0123456789abcdef")).rejects.toThrow(SECRETS_MASTER_KEY_INVALID);
    await expect(parseMasterKey("not-base64!!")).rejects.toThrow(SECRETS_MASTER_KEY_INVALID);
  });

  it("never puts the supplied key material in the rejection message", async () => {
    const secretish = "c2VjcmV0LWtleS1tYXRlcmlhbC1wYXlsb2Fk";
    const escaped = SECRETS_MASTER_KEY_INVALID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const error = await parseMasterKey(secretish).then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(Error);
    // The message IS the fixed string — not a superset quoting the input, and
    // not a DOMException naming the operation.
    expect((error as Error).message).toBe(SECRETS_MASTER_KEY_INVALID);
    expect((error as Error).message).toMatch(new RegExp(`^${escaped}$`));
    expect((error as Error).message).not.toContain(secretish);
    expect((error as Error).message).not.toContain(b64url(keyBytes(3)));
  });
});

describe("managed secret encryption", () => {
  it("round-trips a secret", async () => {
    const k = await keyring();
    const row = await encryptSecret(TOKEN, "mcp", "jev", k.active, k);
    expect(row.keyId).toBe(SECRET_KEY_ID_ACTIVE);
    expect(row.ivB64).toHaveLength(16); // 12 bytes → 16 base64 chars, no padding
    await expect(decryptSecret({ scope: "mcp", ownerId: "jev", ...row }, k)).resolves.toBe(TOKEN);
  });

  it("round-trips a secret written under the previous key (rotation survival)", async () => {
    const k = await keyring();
    const row = await encryptSecret(TOKEN, "mcp", "jev", k.prev!, k);
    expect(row.keyId).toBe(SECRET_KEY_ID_PREV);
    // Readable through the rotating keyring...
    await expect(decryptSecret({ scope: "mcp", ownerId: "jev", ...row }, k)).resolves.toBe(TOKEN);
    // ...unreadable once the operator retires PREV and promotes ACTIVE.
    const rotated: SecretKeyring = { active: k.active };
    await expect(decryptSecret({ scope: "mcp", ownerId: "jev", ...row }, rotated)).rejects.toThrow(SECRET_DECRYPT_FAILED);
    // Re-entering the secret (the documented re-encryption path) restores it.
    const rewrapped = await encryptSecret(TOKEN, "mcp", "jev", rotated.active, rotated);
    expect(rewrapped.keyId).toBe(SECRET_KEY_ID_ACTIVE);
    await expect(decryptSecret({ scope: "mcp", ownerId: "jev", ...rewrapped }, rotated)).resolves.toBe(TOKEN);
  });

  it("uses a fresh 12-byte IV for every write, so the same secret never repeats a blob", async () => {
    const k = await keyring();
    const a = await encryptSecret(TOKEN, "mcp", "jev", k.active, k);
    const b = await encryptSecret(TOKEN, "mcp", "jev", k.active, k);
    expect(SECRET_IV_BYTES).toBe(12);
    expect(a.ivB64).not.toBe(b.ivB64);
    expect(a.ciphertextB64).not.toBe(b.ciphertextB64);
    // Same IV + plaintext + AAD is deterministic, so the differing ciphertext
    // above really is the fresh IV, not a random tag.
    await expect(decryptSecret({ scope: "mcp", ownerId: "jev", ...a }, k)).resolves.toBe(TOKEN);
    await expect(decryptSecret({ scope: "mcp", ownerId: "jev", ...b }, k)).resolves.toBe(TOKEN);
  });

  it("binds the blob to its scope and owner through the AAD", async () => {
    const k = await keyring();
    const row = await encryptSecret(TOKEN, "mcp", "jev", k.active, k);
    // Copy the row onto another owner: same key, same IV, same ciphertext,
    // and it must NOT decrypt.
    await expect(decryptSecret({ scope: "mcp", ownerId: "other-server", ...row }, k)).rejects.toThrow(
      SECRET_DECRYPT_FAILED
    );
  });

  it("carries no plaintext in the stored columns", async () => {
    const k = await keyring();
    const row = await encryptSecret(TOKEN, "mcp", "jev", k.active, k);
    expect(row.ciphertextB64).not.toContain(TOKEN);
    expect(row.ivB64).not.toContain(TOKEN);
    expect(row.keyId).not.toContain(TOKEN);
  });

  it("defaults to the active slot when no keyring is supplied", async () => {
    const k = await keyring();
    const row = await encryptSecret(TOKEN, "mcp", "jev", k.active);
    expect(row.keyId).toBe(SECRET_KEY_ID_ACTIVE);
    await expect(decryptSecret({ scope: "mcp", ownerId: "jev", ...row }, k)).resolves.toBe(TOKEN);
  });

  it("refuses a key that belongs to no keyring slot", async () => {
    const k = await keyring();
    const foreign = await parseMasterKey(b64(keyBytes(97)));
    // Without a keyring the key is taken at face value (active)...
    await expect(encryptSecret(TOKEN, "mcp", "jev", foreign)).resolves.toMatchObject({ keyId: SECRET_KEY_ID_ACTIVE });
    // ...but paired with a keyring the caller has made a mistake, so it is a
    // fixed-message failure rather than a mislabelled row.
    await expect(encryptSecret(TOKEN, "mcp", "jev", foreign, k)).rejects.toThrow(SECRET_DECRYPT_FAILED);
  });
});

describe("AAD scope isolation", () => {
  it("mcp scope keeps the legacy AAD so existing blobs still open", async () => {
    const key = await parseMasterKey(ACTIVE_RAW);
    const sealed = await encryptSecret("tok", "mcp", "srv-1", key);
    await expect(decryptSecret({ ...sealed, scope: "mcp", ownerId: "srv-1" }, keyringFromKeys(key))).resolves.toBe("tok");
    await expect(decryptSecret({ ...sealed, scope: "provider", ownerId: "srv-1" }, keyringFromKeys(key))).rejects.toThrow(
      SECRET_DECRYPT_FAILED
    );
  });

  it("scope prefixes are frozen", () => {
    expect(SECRET_AAD_PREFIXES.mcp).toBe("lexa-mcp-v1");
    expect(SECRET_AAD_PREFIXES.provider).toBe("lexa-provider-v1");
    expect(SECRET_AAD_PREFIXES.jev).toBe("lexa-jev-v1");
    expect(Object.isFrozen(SECRET_AAD_PREFIXES)).toBe(true);
  });

  it("a blob sealed for one scope cannot be opened under another", async () => {
    const k = await keyring();
    const scopes: SecretScope[] = ["mcp", "provider", "jev"];
    for (const scope of scopes) {
      const row = await encryptSecret(TOKEN, scope, "owner-1", k.active, k);
      for (const other of scopes) {
        const attempt = decryptSecret({ scope: other, ownerId: "owner-1", ...row }, k);
        if (other === scope) await expect(attempt).resolves.toBe(TOKEN);
        else await expect(attempt).rejects.toThrow(SECRET_DECRYPT_FAILED);
      }
      // Same scope, different owner: also refused.
      await expect(decryptSecret({ scope, ownerId: "owner-2", ...row }, k)).rejects.toThrow(SECRET_DECRYPT_FAILED);
    }
  });
});

describe("managed secret decryption failures", () => {
  it("fails on a wrong key, tamper, and an unknown key id — same fixed message each time", async () => {
    const k = await keyring();
    const row = await encryptSecret(TOKEN, "mcp", "jev", k.active, k);
    const blob = { scope: "mcp" as const, ownerId: "jev", ...row };

    // Wrong key: the PREV slot holds different material, no rotation swap.
    await expect(decryptSecret(blob, { active: k.prev! })).rejects.toThrow(SECRET_DECRYPT_FAILED);

    // Tamper: flip one ciphertext byte.
    const bytes = Buffer.from(row.ciphertextB64, "base64");
    bytes[0] = (bytes[0]! ^ 0xff) & 0xff;
    await expect(decryptSecret({ ...blob, ciphertextB64: bytes.toString("base64") }, k)).rejects.toThrow(
      SECRET_DECRYPT_FAILED
    );

    // Tamper: flip one IV byte (the IV is authenticated too).
    const iv = Buffer.from(row.ivB64, "base64");
    iv[0] = (iv[0]! ^ 0xff) & 0xff;
    await expect(decryptSecret({ ...blob, ivB64: iv.toString("base64") }, k)).rejects.toThrow(SECRET_DECRYPT_FAILED);

    // Unknown key id.
    await expect(decryptSecret({ ...blob, keyId: "k9" as SecretKeyId }, k)).rejects.toThrow(SECRET_DECRYPT_FAILED);

    // A row written under PREV, read with no PREV keyring slot.
    const prevRow = await encryptSecret(TOKEN, "mcp", "jev", k.prev!, k);
    await expect(decryptSecret({ scope: "mcp", ownerId: "jev", ...prevRow }, { active: k.active })).rejects.toThrow(
      SECRET_DECRYPT_FAILED
    );
  });

  it("fails on a malformed IV or ciphertext rather than returning garbage", async () => {
    const k = await keyring();
    const row = await encryptSecret(TOKEN, "mcp", "jev", k.active, k);
    await expect(decryptSecret({ scope: "mcp", ownerId: "jev", ...row, ivB64: "" }, k)).rejects.toThrow(
      SECRET_DECRYPT_FAILED
    );
    await expect(decryptSecret({ scope: "mcp", ownerId: "jev", ...row, ivB64: "!!!" }, k)).rejects.toThrow(
      SECRET_DECRYPT_FAILED
    );
    await expect(decryptSecret({ scope: "mcp", ownerId: "jev", ...row, ciphertextB64: "" }, k)).rejects.toThrow(
      SECRET_DECRYPT_FAILED
    );
    // A short (non-12-byte) IV is a hard AES-GCM input error, not a valid one.
    await expect(decryptSecret({ scope: "mcp", ownerId: "jev", ...row, ivB64: b64(new Uint8Array(11)) }, k)).rejects.toThrow(
      SECRET_DECRYPT_FAILED
    );
  });

  it("keeps the plaintext, the ciphertext and the key out of every failure message", async () => {
    const k = await keyring();
    const row = await encryptSecret(TOKEN, "mcp", "jev", k.active, k);
    const blob = { scope: "mcp" as const, ownerId: "jev", ...row };
    const attempts: Array<() => Promise<string>> = [
      () => decryptSecret(blob, { active: k.prev! }),
      () => decryptSecret({ ...blob, keyId: "k9" as SecretKeyId }, k),
      () => decryptSecret({ ...blob, ciphertextB64: "AAAA" }, k),
      () => decryptSecret({ ...blob, ivB64: "AAAA" }, k),
    ];
    for (const attempt of attempts) {
      const error = await attempt().then(
        () => null,
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toBe(SECRET_DECRYPT_FAILED);
      expect(message).not.toContain(TOKEN);
      expect(message).not.toContain(row.ciphertextB64);
      expect(message).not.toContain(row.ivB64);
      // A DOMException from crypto.subtle would name the runtime class and the
      // operation; only the fixed message ever escapes. The copy legitimately
      // says "decrypted", so the guard names what a leak would actually carry:
      // the DOMException class, the crypto entry point, or the base64 helpers.
      expect(message).not.toMatch(/OperationError|DOMException|InvalidAccessError|subtle|atob|btoa|importKey/i);
    }
  });
});

describe("secretsManagedEnabled (the capability flag on the list response)", () => {
  it("is true when a master key is configured, false when none is", async () => {
    await expect(secretsManagedEnabled({})).resolves.toBe(false);
    await expect(secretsManagedEnabled(undefined)).resolves.toBe(false);
    await expect(secretsManagedEnabled(null)).resolves.toBe(false);
    await expect(secretsManagedEnabled({ LXK_SECRETS_MASTER_KEY: ACTIVE_RAW })).resolves.toBe(true);
    await expect(
      secretsManagedEnabled({ LXK_SECRETS_MASTER_KEY: ACTIVE_RAW, LXK_SECRETS_MASTER_KEY_PREV: PREV_RAW })
    ).resolves.toBe(true);
  });

  it("is false for a blank or whitespace-only key, which secretsKeyringFromEnv treats as unset", async () => {
    await expect(secretsManagedEnabled({ LXK_SECRETS_MASTER_KEY: "" })).resolves.toBe(false);
    await expect(secretsManagedEnabled({ LXK_SECRETS_MASTER_KEY: "   " })).resolves.toBe(false);
    // A PREV key with no active key is still off: nothing can be encrypted.
    await expect(secretsManagedEnabled({ LXK_SECRETS_MASTER_KEY_PREV: PREV_RAW })).resolves.toBe(false);
  });

  it("reports true for a configured-but-malformed key, and never throws — the save path owns the diagnosis", async () => {
    // secretsKeyringFromEnv REJECTS here; the capability flag must not fail the
    // list request, and must not claim managed secrets are off (the key IS
    // set). Save still refuses with SECRETS_MASTER_KEY_INVALID, which is where
    // the operator is told the required shape.
    await expect(secretsManagedEnabled({ LXK_SECRETS_MASTER_KEY: "too-short" })).resolves.toBe(true);
    await expect(
      secretsManagedEnabled({ LXK_SECRETS_MASTER_KEY: ACTIVE_RAW, LXK_SECRETS_MASTER_KEY_PREV: "nope" })
    ).resolves.toBe(true);
  });
});

describe("key id convention", () => {
  it("names the two keyring slots, and the row stores exactly that", () => {
    // Frozen convention: key_id is the keyring SLOT the blob was encrypted
    // with ("active" | "prev") — never a key fingerprint, a counter, or a
    // date. Rotation therefore never needs a rewrap to stay readable: a PREV
    // row keeps resolving through the PREV slot, and the row stays honest
    // about which key it belongs to.
    expect(SECRET_KEY_ID_ACTIVE).toBe("active");
    expect(SECRET_KEY_ID_PREV).toBe("prev");
  });

  it("resolves a key to its slot by identity, and reports null for a foreign key", async () => {
    const k = await keyring();
    expect(keyIdFor(k.active)).toBe(SECRET_KEY_ID_ACTIVE);
    expect(keyIdFor(k.prev!)).toBe(SECRET_KEY_ID_PREV);
    const foreign = await parseMasterKey(b64(keyBytes(97)));
    expect(keyIdFor(foreign)).toBeNull();
  });
});

describe("secretsKeyringFromEnv", () => {
  it("returns null when no master key is configured (feature disabled)", async () => {
    await expect(secretsKeyringFromEnv({})).resolves.toBeNull();
    await expect(secretsKeyringFromEnv({ LXK_SECRETS_MASTER_KEY: "", LXK_SECRETS_MASTER_KEY_PREV: PREV_RAW })).resolves.toBeNull();
  });

  it("builds the active-only keyring, and the active+prev keyring on a rotation", async () => {
    const activeOnly = await secretsKeyringFromEnv({ LXK_SECRETS_MASTER_KEY: ACTIVE_RAW });
    expect(activeOnly?.prev).toBeUndefined();
    expect(keyIdFor(activeOnly!.active)).toBe(SECRET_KEY_ID_ACTIVE);

    const rotating = await secretsKeyringFromEnv({ LXK_SECRETS_MASTER_KEY: ACTIVE_RAW, LXK_SECRETS_MASTER_KEY_PREV: PREV_RAW });
    expect(keyIdFor(rotating!.active)).toBe(SECRET_KEY_ID_ACTIVE);
    expect(keyIdFor(rotating!.prev!)).toBe(SECRET_KEY_ID_PREV);

    // PREV alone never enables the feature: a save still needs an active key.
    await expect(secretsKeyringFromEnv({ LXK_SECRETS_MASTER_KEY_PREV: PREV_RAW })).resolves.toBeNull();
  });

  it("refuses a malformed configured key rather than silently disabling", async () => {
    await expect(secretsKeyringFromEnv({ LXK_SECRETS_MASTER_KEY: "too-short" })).rejects.toThrow(
      SECRETS_MASTER_KEY_INVALID
    );
    await expect(
      secretsKeyringFromEnv({ LXK_SECRETS_MASTER_KEY: ACTIVE_RAW, LXK_SECRETS_MASTER_KEY_PREV: "nope" })
    ).rejects.toThrow(SECRETS_MASTER_KEY_INVALID);
  });
});

describe("module surface", () => {
  it("uses Web Crypto and the base64 helpers only — no node: imports (Workers parity)", () => {
    // The Workers bundle has no node: builtins, so a node import here would
    // break the Cloudflare build. Asserted by source, not by running Workers.
    const source = readFileSync(MODULE_PATH, "utf8");
    expect(source).not.toMatch(/from\s+["']node:/);
    expect(source).not.toMatch(/require\(\s*["']node:/);
    expect(source).not.toMatch(/\bBuffer\b/);
    // Plain assistant-tier module: no Effect.Service, no logging, no DB.
    expect(source).not.toMatch(/Effect\.Service/);
    expect(source).not.toMatch(/console\.(log|warn|error|info|debug)/);
    expect(source).not.toMatch(/process\.(stderr|stdout|env)/);
  });

  it("writes nothing to stderr when a secret operation fails", async () => {
    const k = await keyring();
    const row = await encryptSecret(TOKEN, "mcp", "jev", k.active, k);
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await decryptSecret({ scope: "mcp", ownerId: "other", ...row }, k).catch(() => undefined);
      await parseMasterKey("bad").catch(() => undefined);
    } finally {
      process.stderr.write = original;
    }
    expect(written).toEqual([]);
  });
});
