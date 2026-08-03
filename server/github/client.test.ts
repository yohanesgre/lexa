import { describe, it, expect } from "vitest";
import { createPrivateKey } from "node:crypto";
import { createAppJwt, verifyWebhookSignature } from "./crypto";

async function makeTestPem(pkcs1 = false): Promise<string> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );
  const raw = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const b64 = Buffer.from(raw).toString("base64");
  const lines = b64.match(/.{1,64}/g) ?? [];
  const pem = `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----`;
  if (!pkcs1) return pem;
  // Convert to the PKCS#1 form GitHub actually ships ("BEGIN RSA PRIVATE KEY").
  return createPrivateKey(pem)
    .export({ type: "pkcs1", format: "pem" })
    .toString();
}

function decodeJwtParts(jwt: string): { header: any; payload: any } {
  const [h, p] = jwt.split(".");
  const decode = (seg: string) => JSON.parse(Buffer.from(seg.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8"));
  return { header: decode(h), payload: decode(p) };
}

describe("createAppJwt", () => {
  it("emits a JWT with the app id claim and valid window", async () => {
    const pem = await makeTestPem();
    const now = 1_750_000_000;
    const jwt = await createAppJwt("12345", pem, now);
    const { header, payload } = decodeJwtParts(jwt);
    expect(header.alg).toBe("RS256");
    expect(header.typ).toBe("JWT");
    expect(payload.iss).toBe("12345");
    expect(payload.iat).toBe(now - 60);
    expect(payload.exp).toBe(now + 540);
  });

  it("accepts GitHub's PKCS#1 PEM (BEGIN RSA PRIVATE KEY)", async () => {
    const pem = await makeTestPem(true);
    expect(pem.startsWith("-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
    const jwt = await createAppJwt("12345", pem, 1_750_000_000);
    expect(decodeJwtParts(jwt).payload.iss).toBe("12345");
  });

  it("rejects a malformed PEM", () => {
    expect(() => createAppJwt("1", "not a pem", 100)).toThrow();
  });
});

describe("verifyWebhookSignature", () => {
  const secret = "s3cret";
  const body = new TextEncoder().encode('{"action":"closed"}').buffer;

  async function hmacHex(data: ArrayBuffer, keySecret: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(keySecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, data);
    return Buffer.from(sig).toString("hex");
  }

  it("accepts a valid signature", async () => {
    const sig = await hmacHex(body, secret);
    await expect(verifyWebhookSignature(body, `sha256=${sig}`, secret)).resolves.toBe(true);
  });

  it("rejects a wrong secret", async () => {
    const sig = await hmacHex(body, "other");
    await expect(verifyWebhookSignature(body, `sha256=${sig}`, secret)).resolves.toBe(false);
  });

  it("rejects a tampered body", async () => {
    const sig = await hmacHex(body, secret);
    const tampered = new TextEncoder().encode('{"action":"opened"}').buffer;
    await expect(verifyWebhookSignature(tampered, `sha256=${sig}`, secret)).resolves.toBe(false);
  });

  it("rejects missing or malformed headers", async () => {
    await expect(verifyWebhookSignature(body, null, secret)).resolves.toBe(false);
    await expect(verifyWebhookSignature(body, "md5=abc", secret)).resolves.toBe(false);
    await expect(verifyWebhookSignature(body, "sha256=", secret)).resolves.toBe(false);
  });
});
