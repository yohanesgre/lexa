// Chat attachment model + caps (LX-2). Images and documents share ONE count;
// the composer picker, chips, meter and error copy are all driven from here.
// `assistant-image.ts` keeps its name for historical reasons (the surface grew
// from image-only) but now owns the whole composer attachment vocabulary.

export type ChatAttachmentKind = "image" | "document";

// A wire ref for `POST /assistant/chat/stream` — exactly the server contract.
// `sizeBytes`/`previewUrl` are client-only affordances for the optimistic turn
// render and are stripped before the ref is sent.
export interface ChatAttachmentRef {
  storageKey: string;
  mimeType: string;
  name: string;
  sizeBytes?: number | undefined;
  previewUrl?: string | undefined;
}

export type ChatUploadStatus = "uploading" | "ready" | "failed" | "extraction-failed";

// One picked file while it lives in the composer. Bytes are counted in the
// meter for uploading + ready + failed + extraction-failed states (a rejected
// pick never becomes one of these).
export interface ComposerAttachment {
  id: string;
  kind: ChatAttachmentKind;
  file: File;
  name: string;
  size: number;
  mimeType: string;
  // Object URL for image previews, revoked when the chip leaves the strip.
  previewUrl?: string | undefined;
  status: ChatUploadStatus;
  progress: number;
  storageKey?: string | undefined;
}

// A pick-time rejection row (unsupported / oversize / empty) — never a chip,
// never counted, dismissible.
export interface ComposerRejection {
  id: string;
  message: string;
}

export interface ChatAttachmentCaps {
  maxCount: number;
  maxBytesEach: number;
  maxTotalBytes: number;
}

export const CHAT_ATTACHMENT_CAPS: ChatAttachmentCaps = {
  maxCount: 3,
  maxBytesEach: 5 * 1024 * 1024,
  maxTotalBytes: 10 * 1024 * 1024,
};

export const CHAT_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const CHAT_DOCUMENT_TYPES = ["application/pdf", "text/markdown", "text/plain", "text/csv"];

// Extensions the native picker offers; the server SNIFFS the real mime, so the
// client filter is a convenience, never the security boundary.
export const IMAGE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp,.png,.jpg,.jpeg,.gif,.webp";
export const DOCUMENT_ACCEPT = "application/pdf,text/markdown,text/plain,text/csv,.pdf,.txt,.md,.markdown,.csv";

const DOCUMENT_EXTENSIONS = new Set(["pdf", "txt", "md", "markdown", "csv"]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

// A file's kind, or null when neither its mime nor its extension is allowed.
// `.md`/`.csv` browsers often report as "" — the extension fallback covers it.
export function chatAttachmentKind(file: { name: string; type: string }): ChatAttachmentKind | null {
  if (CHAT_IMAGE_TYPES.includes(file.type)) return "image";
  if (CHAT_DOCUMENT_TYPES.includes(file.type)) return "document";
  const ext = extensionOf(file.name);
  if (DOCUMENT_EXTENSIONS.has(ext)) return "document";
  return null;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${Math.round(bytes / 1024)}KB`;
}

export function formatMegaBytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

// The fixed rejection copy (wireframe): name interpolated, limit read from the
// running values, never hand-rounded.
export function unsupportedMessage(name: string): string {
  return `${name} — unsupported file type. Images: png, jpeg, gif, webp · Documents: pdf, txt, md, csv.`;
}

export function oversizeMessage(name: string, size: number, caps: ChatAttachmentCaps): string {
  return `${name} — ${(size / (1024 * 1024)).toFixed(1)} MB exceeds the ${Math.round(caps.maxBytesEach / (1024 * 1024))} MB per-file limit.`;
}

export function emptyMessage(name: string): string {
  return `${name} is empty (0 bytes) — nothing to attach.`;
}

export const COUNT_LIMIT_MESSAGE = "Max 3 attachments per message — remove one to add another";
export const TOTAL_LIMIT_MESSAGE = "Attachments exceed the 10 MB total limit";
export const UPLOAD_FAILED_PREFIX = "Upload failed — ";
export function uploadFailedMessage(name: string): string {
  return `${UPLOAD_FAILED_PREFIX}${name}.`;
}
export function extractionFailedMessage(name: string): string {
  return `Couldn't read ${name} — text extraction failed. Remove it to send.`;
}

// Counted bytes = every chip in the strip, regardless of upload status.
export function countedBytes(attachments: ComposerAttachment[]): number {
  return attachments.reduce((sum, a) => sum + a.size, 0);
}

export interface PickResult {
  accepted: File[];
  rejections: string[];
  warning: string | null;
}

// Caps are enforced at pick time, cumulatively within one multi-select:
// unsupported / oversize / zero-byte reject the file (error row); count and
// total reject it (warning line). Never silently dropped.
export function pickAttachments(files: File[], current: ComposerAttachment[], caps: ChatAttachmentCaps = CHAT_ATTACHMENT_CAPS): PickResult {
  const rejections: string[] = [];
  const accepted: File[] = [];
  let warning: string | null = null;
  const count = current.length;
  let total = countedBytes(current);

  for (const file of files) {
    const kind = chatAttachmentKind(file);
    if (kind === null) {
      if (file.size === 0) {
        rejections.push(emptyMessage(file.name));
      } else {
        rejections.push(unsupportedMessage(file.name));
      }
      continue;
    }
    if (file.size === 0) {
      rejections.push(emptyMessage(file.name));
      continue;
    }
    if (file.size > caps.maxBytesEach) {
      rejections.push(oversizeMessage(file.name, file.size, caps));
      continue;
    }
    if (count + accepted.length >= caps.maxCount) {
      warning = COUNT_LIMIT_MESSAGE;
      continue;
    }
    if (total + file.size > caps.maxTotalBytes) {
      warning = TOTAL_LIMIT_MESSAGE;
      continue;
    }
    accepted.push(file);
    total += file.size;
  }
  return { accepted, rejections, warning };
}

// Paste path: images only (documents only arrive through the picker), capped.
export function pickPastedImages(files: File[], current: ComposerAttachment[], caps: ChatAttachmentCaps = CHAT_ATTACHMENT_CAPS): PickResult | null {
  const images = files.filter((f) => f.type.startsWith("image/"));
  if (images.length === 0) return null;
  return pickAttachments(images, current, caps);
}
