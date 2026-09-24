import { describe, expect, it } from "vitest";
import { UrlBlocked, validateUrl } from "./ssrf";

describe("validateUrl", () => {
  it("fails closed when the host cannot be resolved", async () => {
    await expect(validateUrl("http://lexa-unresolvable.invalid/", null)).rejects.toBeInstanceOf(UrlBlocked);
  });

  it("blocks private and loopback hosts before any lookup", async () => {
    await expect(validateUrl("http://127.0.0.1/", null)).rejects.toBeInstanceOf(UrlBlocked);
    await expect(validateUrl("http://[::1]/", null)).rejects.toBeInstanceOf(UrlBlocked);
    await expect(validateUrl("http://localhost/", null)).rejects.toBeInstanceOf(UrlBlocked);
  });
});
