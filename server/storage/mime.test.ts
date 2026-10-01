import { describe, expect, it } from "vitest";
import {
  isChatAttachmentMime,
  isChatImageMime,
  isInlineMime,
  resolveChatAttachmentMime,
  sniffMime,
} from "./mime";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const GIF = new TextEncoder().encode("GIF89a....");
const PDF = new TextEncoder().encode("%PDF-1.7 ...");
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const SVG = new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>');
const SVG_BARE = new TextEncoder().encode("<svg xmlns=\"http://www.w3.org/2000/svg\"><script/></svg>");
const HTML = new TextEncoder().encode("<!DOCTYPE html><html><body>x</body></html>");
const CSV = new TextEncoder().encode("a,b,c\n1,2,3\n");
const XLSX = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]);

describe("sniffMime", () => {
  it("detects image formats by magic bytes", () => {
    expect(sniffMime(PNG)).toBe("image/png");
    expect(sniffMime(JPEG)).toBe("image/jpeg");
    expect(sniffMime(GIF)).toBe("image/gif");
    expect(sniffMime(WEBP)).toBe("image/webp");
  });

  it("detects pdf", () => {
    expect(sniffMime(PDF)).toBe("application/pdf");
  });

  it("lying extension: svg bytes renamed .png sniff as svg+xml", () => {
    expect(sniffMime(SVG)).toBe("image/svg+xml");
    expect(sniffMime(SVG_BARE)).toBe("image/svg+xml");
  });

  it("unknown / text / zip-container content sniffs null", () => {
    expect(sniffMime(HTML)).toBeNull();
    expect(sniffMime(CSV)).toBeNull();
    expect(sniffMime(XLSX)).toBeNull();
    expect(sniffMime(new Uint8Array(0))).toBeNull();
  });
});

describe("isInlineMime", () => {
  it("image/* (except SVG) and application/pdf render inline; everything else downloads", () => {
    expect(isInlineMime("image/png")).toBe(true);
    expect(isInlineMime("image/svg+xml")).toBe(false);
    expect(isInlineMime("application/pdf")).toBe(true);
    expect(isInlineMime("text/html")).toBe(false);
    expect(isInlineMime("text/csv")).toBe(false);
    expect(isInlineMime("application/octet-stream")).toBe(false);
  });
});

describe("chat attachment mime", () => {
  const MD = new TextEncoder().encode("# Title\n\nsome body text");
  const TXT = new TextEncoder().encode("plain words");
  const NUL_BYTES = new Uint8Array([0x61, 0x00, 0x62, 0x63]);

  it("magic bytes win: allowed images/PDF resolve to their sniffed type", () => {
    expect(resolveChatAttachmentMime("x.bin", PNG)).toBe("image/png");
    expect(resolveChatAttachmentMime("x.bin", JPEG)).toBe("image/jpeg");
    expect(resolveChatAttachmentMime("x.bin", GIF)).toBe("image/gif");
    expect(resolveChatAttachmentMime("x.bin", WEBP)).toBe("image/webp");
    expect(resolveChatAttachmentMime("paper.pdf", PDF)).toBe("application/pdf");
  });

  it("sniffed-but-unsupported types are rejected outright, never text-probed", () => {
    expect(resolveChatAttachmentMime("lie.png", SVG)).toBeNull();
    expect(resolveChatAttachmentMime("lie.png", SVG_BARE)).toBeNull();
    expect(resolveChatAttachmentMime("logo.bmp", new Uint8Array([0x42, 0x4d, 0, 0]))).toBeNull();
    expect(resolveChatAttachmentMime("book.xlsx", XLSX)).toBeNull();
  });

  it("unsigned UTF-8 text classifies by extension; binary and empty reject", () => {
    expect(resolveChatAttachmentMime("notes.md", MD)).toBe("text/markdown");
    expect(resolveChatAttachmentMime("notes.markdown", MD)).toBe("text/markdown");
    expect(resolveChatAttachmentMime("readme.MD", MD)).toBe("text/markdown");
    expect(resolveChatAttachmentMime("notes.txt", TXT)).toBe("text/plain");
    expect(resolveChatAttachmentMime("no-ext", TXT)).toBe("text/plain");
    expect(resolveChatAttachmentMime("binary.txt", NUL_BYTES)).toBeNull();
    expect(resolveChatAttachmentMime("empty.txt", new Uint8Array(0))).toBeNull();
  });

  it("allowlist and image predicate agree with the resolver", () => {
    for (const m of ["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf", "text/markdown", "text/plain"]) {
      expect(isChatAttachmentMime(m), m).toBe(true);
    }
    expect(isChatAttachmentMime("image/svg+xml")).toBe(false);
    expect(isChatAttachmentMime("image/bmp")).toBe(false);
    expect(isChatImageMime("image/gif")).toBe(true);
    expect(isChatImageMime("application/pdf")).toBe(false);
    expect(isChatImageMime("text/markdown")).toBe(false);
  });
});
