// Magic-byte mime sniffing. The client-declared content type is untrusted:
// the sniffed type is what gets stored on the attachment row and what drives
// the inline-vs-download decision at serve time. A .svg renamed .png sniffs
// as image/svg+xml → forced download (SVG can carry script).
export function sniffMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 8) {
    if (bytes[0]! === 0x89 && bytes[1]! === 0x50 && bytes[2]! === 0x4e && bytes[3]! === 0x47
      && bytes[4]! === 0x0d && bytes[5]! === 0x0a && bytes[6]! === 0x1a && bytes[7]! === 0x0a) {
      return "image/png";
    }
    if (bytes[0]! === 0x52 && bytes[1]! === 0x49 && bytes[2]! === 0x46 && bytes[3]! === 0x46
      && bytes.length >= 12 && bytes[8]! === 0x57 && bytes[9]! === 0x45 && bytes[10]! === 0x42 && bytes[11]! === 0x50) {
      return "image/webp";
    }
  }
  if (bytes.length >= 3 && bytes[0]! === 0xff && bytes[1]! === 0xd8 && bytes[2]! === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6) {
    const gif = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!, bytes[4]!, bytes[5]!);
    if (gif === "GIF87a" || gif === "GIF89a") return "image/gif";
  }
  if (bytes.length >= 5) {
    const pdf = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!, bytes[4]!);
    if (pdf === "%PDF-") return "application/pdf";
  }
  if (bytes.length >= 2 && bytes[0]! === 0x42 && bytes[1]! === 0x4d) {
    return "image/bmp";
  }
  if (bytes.length >= 4 && bytes[0]! === 0x00 && bytes[1]! === 0x00 && bytes[2]! === 0x01 && bytes[3]! === 0x00) {
    return "image/x-icon";
  }
  if (looksLikeSvg(bytes)) return "image/svg+xml";
  return null;
}

// SVG is text: optional BOM/whitespace, then an XML prolog and/or <svg.
function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.slice(0, Math.min(bytes.length, 512)))
    .replace(/^\uFEFF/, "")
    .trimStart()
    .toLowerCase();
  if (!head.startsWith("<")) return false;
  const probe = head.slice(0, 200);
  if (probe.startsWith("<svg")) return true;
  return probe.startsWith("<?xml") && head.includes("<svg");
}

// Inline rendering allowlist — image/* (except SVG) and application/pdf ONLY.
// Everything else (html, svg, csv, xlsx, unknown) forces download.
export function isInlineMime(mime: string): boolean {
  return mime === "application/pdf" || (mime.startsWith("image/") && mime !== "image/svg+xml");
}

// Chat attachment allowlist. Images feed the vision path; PDF/markdown/plain
// text are extracted to model-visible text (see server/services/assistant-helpers).
export const CHAT_ATTACHMENT_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/markdown",
  "text/plain",
] as const;

export function isChatAttachmentMime(mime: string): boolean {
  return (CHAT_ATTACHMENT_MIME_TYPES as readonly string[]).includes(mime);
}

export function isChatImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

// Server-side mime resolution for a chat upload. Magic bytes win and are
// authoritative: a sniffed-but-unsupported type (bmp/ico/svg) is rejected
// outright rather than falling through to the text probe. Only content with NO
// magic signature is treated as text — valid UTF-8, no NUL, and then classified
// by extension (`.md`/`.markdown` → text/markdown, else text/plain). Returns
// null when the bytes are neither an allowed binary type nor plain text.
export function resolveChatAttachmentMime(filename: string, bytes: Uint8Array): string | null {
  const sniffed = sniffMime(bytes);
  if (sniffed !== null) return isChatAttachmentMime(sniffed) ? sniffed : null;
  if (!looksLikeUtf8Text(bytes)) return null;
  return /\.(md|markdown)$/i.test(filename) ? "text/markdown" : "text/plain";
}

function looksLikeUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  const probe = bytes.subarray(0, Math.min(bytes.length, 8192));
  if (probe.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(probe);
    return true;
  } catch {
    return false;
  }
}

