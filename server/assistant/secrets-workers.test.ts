// Workers parity: the sealed-blob wire format must mean the same thing on
// workerd as on Bun. `secrets.ts` picks AES-256-GCM with a 12-byte IV, a
// 128-bit tag and an AAD of `<prefix>:<owner_id>`; a drift in any of those on
// one runtime would surface as a hard refusal in production only, on whichever
// runtime nobody tested. So both directions are asserted against a real workerd
// (miniflare), not a stub.
//
// The worker receives the blob over fetch and re-derives the same AES-GCM
// parameters itself — it does NOT import the module, so a change on either side
// that breaks the shared format fails here.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  SECRETS_MASTER_KEY_BYTES,
  SECRET_AAD_PREFIXES,
  SECRET_IV_BYTES,
  decryptSecret,
  encryptSecret,
  keyringFromKeys,
  parseMasterKey,
} from "./secrets";

const TOKEN = "ghp_workerdparitytoken0123456789";
const SERVER_ID = "parity-mcp";

// workerd re-implements the format; the AAD prefix is interpolated from the
// module so the two sides can never drift silently.
const WORKER = `
const b64d = (value) => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};
const b64 = (bytes) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};
const importKey = (keyB64) =>
  crypto.subtle.importKey("raw", b64d(keyB64), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);

export default {
  async fetch(request) {
    const body = await request.json();
    try {
      const key = await importKey(body.keyB64);
      const aad = new TextEncoder().encode("${SECRET_AAD_PREFIXES.mcp}:" + body.serverId);
      if (body.mode === "decrypt") {
        const plain = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: b64d(body.ivB64), additionalData: aad, tagLength: 128 },
          key,
          b64d(body.ciphertextB64)
        );
        return new Response(JSON.stringify({ ok: true, plaintext: new TextDecoder().decode(plain) }));
      }
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const sealed = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
        key,
        new TextEncoder().encode(body.plaintext)
      );
      return new Response(JSON.stringify({ ok: true, ciphertextB64: b64(new Uint8Array(sealed)), ivB64: b64(iv) }));
    } catch (e) {
      // Only the failure CLASS crosses the boundary — the message never quotes
      // the key, the IV, or the ciphertext.
      return new Response(JSON.stringify({ ok: false, name: String(e.name) }));
    }
  },
};
`;

let mf: Miniflare | undefined;

async function call(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await mf!.dispatchFetch("http://parity/", { method: "POST", body: JSON.stringify(payload) });
  return (await res.json()) as Record<string, unknown>;
}

function keyB64(seed: number): string {
  const bytes = Uint8Array.from({ length: SECRETS_MASTER_KEY_BYTES }, (_, i) => (seed * 31 + i * 7) % 256);
  return btoa(String.fromCharCode(...bytes));
}

describe("workerd parity for the managed-secret blob format", () => {
  beforeAll(async () => {
    mf = new Miniflare(
      await convertV4MiniflareOptions({ workers: [{ name: "secrets-parity", modules: true, script: WORKER }] })
    );
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
  });

  it("opens a Bun-sealed blob inside workerd (Bun writes, workerd reads)", async () => {
    const raw = keyB64(3);
    const keyring = keyringFromKeys(await parseMasterKey(raw));
    const row = await encryptSecret(TOKEN, "mcp", SERVER_ID, keyring.active, keyring);
    expect(row.ivB64).toHaveLength(16);

    const result = await call({
      mode: "decrypt",
      keyB64: raw,
      serverId: SERVER_ID,
      ivB64: row.ivB64,
      ciphertextB64: row.ciphertextB64,
    });
    expect(result).toEqual({ ok: true, plaintext: TOKEN });
  }, 30_000);

  it("reads a workerd-sealed blob on Bun (workerd writes, Bun reads)", async () => {
    const raw = keyB64(11);
    const keyring = keyringFromKeys(await parseMasterKey(raw));

    const result = await call({ mode: "encrypt", keyB64: raw, serverId: SERVER_ID, plaintext: TOKEN });
    expect(result.ok).toBe(true);
    expect(result.plaintext).toBeUndefined();
    expect(result.ivB64).toBeTypeOf("string");

    await expect(
      decryptSecret(
        {
          scope: "mcp",
          ownerId: SERVER_ID,
          ciphertextB64: result.ciphertextB64 as string,
          ivB64: result.ivB64 as string,
          keyId: "active",
        },
        keyring
      )
    ).resolves.toBe(TOKEN);
  }, 30_000);

  it("uses a 12-byte IV and rejects a wrong key the same way on workerd", async () => {
    const raw = keyB64(3);
    const keyring = keyringFromKeys(await parseMasterKey(raw));
    const row = await encryptSecret(TOKEN, "mcp", SERVER_ID, keyring.active, keyring);
    // The IV length is the wire contract, not a Bun-side detail.
    expect(SECRET_IV_BYTES).toBe(12);
    expect(atob(row.ivB64).length).toBe(SECRET_IV_BYTES);

    const wrongKey = await call({
      mode: "decrypt",
      keyB64: keyB64(97),
      serverId: SERVER_ID,
      ivB64: row.ivB64,
      ciphertextB64: row.ciphertextB64,
    });
    // An AEAD rejection on workerd surfaces as a DOMException name only — no
    // plaintext, no ciphertext, no key in what crosses back.
    expect(wrongKey.ok).toBe(false);
    expect(JSON.stringify(wrongKey)).not.toContain(TOKEN);
    expect(JSON.stringify(wrongKey)).not.toContain(row.ciphertextB64);
  }, 30_000);

  it("refuses a blob replayed against a different server id", async () => {
    const raw = keyB64(3);
    const keyring = keyringFromKeys(await parseMasterKey(raw));
    const row = await encryptSecret(TOKEN, "mcp", SERVER_ID, keyring.active, keyring);

    const replayed = await call({
      mode: "decrypt",
      keyB64: raw,
      serverId: "other-server",
      ivB64: row.ivB64,
      ciphertextB64: row.ciphertextB64,
    });
    expect(replayed.ok).toBe(false);
  }, 30_000);
});
