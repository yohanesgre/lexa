import { describe, it, expect } from "vitest";
import { isPrivateIp, isPublicUrl } from "./hearth-ssrf";

describe("isPrivateIp", () => {
  it("flags RFC1918 private ranges", () => {
    expect(isPrivateIp("10.0.0.1")).toBe(true);
    expect(isPrivateIp("172.16.0.1")).toBe(true);
    expect(isPrivateIp("172.31.255.255")).toBe(true);
    expect(isPrivateIp("192.168.1.1")).toBe(true);
  });

  it("flags loopback and link-local", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("169.254.169.254")).toBe(true); // cloud metadata
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("::")).toBe(true);
    expect(isPrivateIp("fe80::1")).toBe(true);
  });

  it("flags CGNAT and ULA", () => {
    expect(isPrivateIp("100.64.0.1")).toBe(true);
    expect(isPrivateIp("fc00::1")).toBe(true);
    expect(isPrivateIp("fd12:3456::1")).toBe(true);
  });

  it("allows public addresses", () => {
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("1.1.1.1")).toBe(false);
    expect(isPrivateIp("140.82.112.3")).toBe(false);
    expect(isPrivateIp("2606:4700:4700::1111")).toBe(false);
  });
});

describe("isPublicUrl", () => {
  it("accepts http/https", () => {
    expect(isPublicUrl("https://example.com").ok).toBe(true);
    expect(isPublicUrl("http://example.com/page").ok).toBe(true);
  });

  it("rejects non-http protocols", () => {
    expect(isPublicUrl("file:///etc/passwd").ok).toBe(false);
    expect(isPublicUrl("ftp://example.com").ok).toBe(false);
    expect(isPublicUrl("gopher://example.com").ok).toBe(false);
  });

  it("rejects malformed urls", () => {
    expect(isPublicUrl("not a url").ok).toBe(false);
  });
});
