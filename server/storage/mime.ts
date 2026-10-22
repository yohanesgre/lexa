import { DOCUMENT_MIME, DOCUMENT_MIME_TYPES } from "../../shared/document-formats";


// Magic-byte mime sniffing. Client-declared content type is untrusted.
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
  if (bytes.length >= 3 && bytes[0]! === 0xff && bytes[1]! === 0xd8 && bytes[2]! === 0xff) return "image/jpeg";
  if (bytes.length >= 6) {
    const gif = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!, bytes[4]!, bytes[5]!);
    if (gif === "GIF87a" || gif === "GIF89a") return "image/gif";
  }
  if (bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === "%PDF-") return DOCUMENT_MIME.pdf;
  if (bytes.length >= 2 && bytes[0]! === 0x42 && bytes[1]! === 0x4d) return "image/bmp";
  if (bytes.length >= 4 && bytes[0]! === 0x00 && bytes[1]! === 0x00 && bytes[2]! === 0x01 && bytes[3]! === 0x00) return "image/x-icon";
  if (looksLikeSvg(bytes)) return "image/svg+xml";
  return null;
}

function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(0, Math.min(bytes.length, 512)))
    .replace(/^\uFEFF/, "")
    .trimStart()
    .toLowerCase();
  if (!head.startsWith("<")) return false;
  const probe = head.slice(0, 200);
  return probe.startsWith("<svg") || (probe.startsWith("<?xml") && head.includes("<svg"));
}

export function isInlineMime(mime: string): boolean {
  return mime === DOCUMENT_MIME.pdf || (mime.startsWith("image/") && mime !== "image/svg+xml");
}

export const CHAT_ATTACHMENT_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  ...DOCUMENT_MIME_TYPES,
] as const;

export function isChatAttachmentMime(mime: string): boolean {
  return (CHAT_ATTACHMENT_MIME_TYPES as readonly string[]).includes(mime);
}

export function isChatImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

export function resolveChatAttachmentMime(filename: string, bytes: Uint8Array): string | null {
  const sniffed = sniffMime(bytes);
  if (sniffed !== null) return isChatAttachmentMime(sniffed) ? sniffed : null;
  if (bytes.length >= 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0
    && bytes[4] === 0xa1 && bytes[5] === 0xb1 && bytes[6] === 0x1a && bytes[7] === 0xe1) {
    try {
      return isLegacyExcelCompoundFile(bytes) ? DOCUMENT_MIME.xls : null;
    } catch {
      return null;
    }
  }
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return sniffOfficeZip(bytes, filename);
  }
  if (!looksLikeUtf8Text(bytes)) return null;
  const text = decodeUtf8(bytes);
  if (text === null) return null;
  const extension = extensionOf(filename);
  if (extension === ".md" || extension === ".markdown") return DOCUMENT_MIME.markdown;
  if (extension === ".txt") return DOCUMENT_MIME.text;
  if (extension === ".csv") return isCsv(text) ? DOCUMENT_MIME.csv : null;
  if (extension === ".html" || extension === ".htm") return isHtml(text) ? DOCUMENT_MIME.html : null;
  if (extension === ".xml") return isXml(text) ? DOCUMENT_MIME.xml : null;
  return null;
}

const ZIP_CENTRAL_DIRECTORY = 0x02014b50;
const ZIP_LOCAL_FILE = 0x04034b50;
const ZIP_END = 0x06054b50;
const ZIP_METADATA_LIMIT = 65_536;
const ZIP_ENTRY_LIMIT = 256;

function sniffOfficeZip(bytes: Uint8Array, filename: string): string | null {
  const entries = readZipEntries(bytes);
  if (!entries) return null;
  const names = new Set(entries.map((entry) => entry.name));
  const hasWord = names.has("word/document.xml");
  const hasXlsx = names.has("xl/workbook.xml");
  const hasXlsb = names.has("xl/workbook.bin");
  const hasSpreadsheet = hasXlsx || hasXlsb;
  if ((hasWord && hasSpreadsheet) || (hasXlsx && hasXlsb)
    || (names.has("mimetype") && (hasWord || hasSpreadsheet))) return null;
  if (hasWord && names.has("[Content_Types].xml") && !names.has("word/vbaProject.bin")) {
    return extensionOf(filename) === ".docx" && names.has("_rels/.rels")
      ? DOCUMENT_MIME.docx
      : null;
  }
  const mimetype = entries.find((entry) => entry.name === "mimetype");
  if (mimetype) {
    if (entries[0]?.name !== "mimetype") return null;
    if (mimetype.method !== 0 || mimetype.data === null || mimetype.data.length > 128) return null;
    const containerMime = decodeUtf8(mimetype.data);
    if (containerMime === DOCUMENT_MIME.odt && extensionOf(filename) === ".odt") {
      return names.has("content.xml") && names.has("META-INF/manifest.xml") ? containerMime : null;
    }
    if (containerMime === DOCUMENT_MIME.ods && extensionOf(filename) === ".ods") {
      return names.has("content.xml") && names.has("META-INF/manifest.xml") ? containerMime : null;
    }
    return null;
  }
  if (!names.has("[Content_Types].xml") || !names.has("_rels/.rels")) return null;
  if (hasXlsb && names.has("xl/_rels/workbook.bin.rels")) {
    return extensionOf(filename) === ".xlsb"
      ? DOCUMENT_MIME.xlsb
      : null;
  }
  if (hasXlsx && names.has("xl/_rels/workbook.xml.rels")) {
    if (names.has("xl/vbaProject.bin")) {
      return extensionOf(filename) === ".xlsm"
        ? DOCUMENT_MIME.xlsm
        : null;
    }
    return extensionOf(filename) === ".xlsx"
      ? DOCUMENT_MIME.xlsx
      : null;
  }
  return null;
}

interface ZipEntry {
  name: string;
  method: number;
  data: Uint8Array | null;
}

function readZipEntries(bytes: Uint8Array): ZipEntry[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lower = Math.max(0, bytes.length - 22 - 65_535);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= lower; offset--) {
    if (view.getUint32(offset, true) === ZIP_END) {
      end = offset;
      break;
    }
  }
  if (end < 0 || end + 22 > bytes.length) return null;
  const disk = view.getUint16(end + 4, true);
  const directoryDisk = view.getUint16(end + 6, true);
  const diskEntries = view.getUint16(end + 8, true);
  const entryCount = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  const commentLength = view.getUint16(end + 20, true);
  if (disk !== 0 || directoryDisk !== 0 || diskEntries !== entryCount || entryCount === 0
    || entryCount > ZIP_ENTRY_LIMIT || directorySize > ZIP_METADATA_LIMIT
    || end + 22 + commentLength !== bytes.length || directoryOffset + directorySize !== end) return null;

  const entries: ZipEntry[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let offset = directoryOffset;
  try {
    for (let index = 0; index < entryCount; index++) {
      if (offset + 46 > end || view.getUint32(offset, true) !== ZIP_CENTRAL_DIRECTORY) return null;
      const flags = view.getUint16(offset + 8, true);
      const method = view.getUint16(offset + 10, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const uncompressedSize = view.getUint32(offset + 24, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const entryCommentLength = view.getUint16(offset + 32, true);
      const startDisk = view.getUint16(offset + 34, true);
      const localOffset = view.getUint32(offset + 42, true);
      const recordEnd = offset + 46 + nameLength + extraLength + entryCommentLength;
      if (flags & 1 || (method !== 0 && method !== 8) || startDisk !== 0
        || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff
        || localOffset + 30 > directoryOffset || recordEnd > end) return null;
      const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
      const name = decoder.decode(nameBytes);
      if (!name || name.startsWith("/") || name.includes("\\") || name.split("/").includes("..")) return null;
      if (entries.some((entry) => entry.name === name)) return null;
      if (view.getUint32(localOffset, true) !== ZIP_LOCAL_FILE) return null;
      const localFlags = view.getUint16(localOffset + 6, true);
      const localMethod = view.getUint16(localOffset + 8, true);
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      const localCompressedSize = view.getUint32(localOffset + 18, true);
      const localUncompressedSize = view.getUint32(localOffset + 22, true);
      if (localFlags !== flags || localMethod !== method || dataEnd > directoryOffset || localNameLength !== nameLength
        || (!(flags & 8) && (localCompressedSize !== compressedSize || localUncompressedSize !== uncompressedSize))) return null;
      for (let char = 0; char < nameLength; char++) {
        if (bytes[localOffset + 30 + char] !== nameBytes[char]) return null;
      }
      const data = method === 0 && compressedSize === uncompressedSize
        ? bytes.subarray(dataStart, dataEnd)
        : null;
      entries.push({ name, method, data });
      offset = recordEnd;
    }
  } catch {
    return null;
  }
  return offset === end ? entries : null;
}

function isLegacyExcelCompoundFile(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const major = view.getUint16(26, true);
  const sectorShift = view.getUint16(30, true);
  const miniSectorShift = view.getUint16(32, true);
  const fatSectorCount = view.getUint32(44, true);
  const directorySector = view.getUint32(48, true);
  const miniStreamCutoff = view.getUint32(56, true);
  const firstDifat = view.getUint32(68, true);
  const difatCount = view.getUint32(72, true);
  const sectorSize = major === 3 && sectorShift === 9 ? 512 : major === 4 && sectorShift === 12 ? 4096 : 0;
  if (sectorSize === 0 || miniSectorShift !== 6 || miniStreamCutoff !== 4096 || difatCount !== 0
    || firstDifat !== 0xfffffffe || bytes.length < sectorSize * 2 || (bytes.length - sectorSize) % sectorSize !== 0
    || directorySector >= Math.floor((bytes.length - sectorSize) / sectorSize)
    || fatSectorCount === 0 || fatSectorCount > 109) return false;

  const sectorCount = Math.floor((bytes.length - sectorSize) / sectorSize);
  const fatSectors: number[] = [];
  for (let index = 0; index < 109; index++) {
    const sector = view.getUint32(76 + index * 4, true);
    if (sector === 0xffffffff) break;
    if (sector >= sectorCount || fatSectors.includes(sector)) return false;
    fatSectors.push(sector);
  }
  if (fatSectors.length !== fatSectorCount) return false;
  const fat: number[] = [];
  for (const sector of fatSectors) {
    const base = sectorSize + sector * sectorSize;
    for (let offset = 0; offset < sectorSize; offset += 4) fat.push(view.getUint32(base + offset, true));
  }
  for (const sector of fatSectors) if (fat[sector] !== 0xfffffffd) return false;

  const directoryBytes = readCompoundChain(bytes, fat, directorySector, sectorSize, sectorCount);
  if (!directoryBytes || directoryBytes.length < 128 || directoryBytes.length % 128 !== 0) return false;
  const entries: Array<{ name: string; type: number; left: number; right: number; child: number }> = [];
  const directoryView = new DataView(directoryBytes.buffer, directoryBytes.byteOffset, directoryBytes.byteLength);
  for (let offset = 0; offset < directoryBytes.length; offset += 128) {
    const nameLength = directoryView.getUint16(offset + 64, true);
    const type = directoryBytes[offset + 66]!;
    const name = type === 0 || nameLength < 2 || nameLength > 64 || nameLength % 2 !== 0
      ? ""
      : new TextDecoder("utf-16le", { fatal: true }).decode(directoryBytes.subarray(offset, offset + nameLength - 2));
    entries.push({
      name,
      type,
      left: directoryView.getUint32(offset + 68, true),
      right: directoryView.getUint32(offset + 72, true),
      child: directoryView.getUint32(offset + 76, true),
    });
  }
  if (entries[0]?.type !== 5 || entries[0].name !== "Root Entry") return false;
  const seen = new Set<number>();
  const rootChildren = new Set<string>();
  const pending = [entries[0].child];
  while (pending.length > 0) {
    const index = pending.pop()!;
    if (index === 0xffffffff) continue;
    if (index >= entries.length || seen.has(index)) return false;
    seen.add(index);
    const entry = entries[index]!;
    if (entry.type !== 1 && entry.type !== 2) return false;
    pending.push(entry.left, entry.right);
    if (entry.type === 2) rootChildren.add(entry.name);
  }
  return (rootChildren.has("Workbook") || rootChildren.has("Book"))
    && !rootChildren.has("WordDocument")
    && !rootChildren.has("PowerPoint Document");
}

function readCompoundChain(bytes: Uint8Array, fat: number[], first: number, sectorSize: number, sectorCount: number): Uint8Array | null {
  const sectors: number[] = [];
  const seen = new Set<number>();
  let sector = first;
  while (sector !== 0xfffffffe) {
    if (sector >= sectorCount || sector >= fat.length || seen.has(sector) || sectors.length >= sectorCount) return null;
    seen.add(sector);
    sectors.push(sector);
    sector = fat[sector]!;
    if (sector === 0xffffffff || sector === 0xfffffffd || sector === 0xfffffffc) return null;
  }
  const output = new Uint8Array(sectors.length * sectorSize);
  for (let index = 0; index < sectors.length; index++) {
    const start = sectorSize + sectors[index]! * sectorSize;
    output.set(bytes.subarray(start, start + sectorSize), index * sectorSize);
  }
  return output;
}

function isCsv(text: string): boolean {
  let quoted = false;
  let fieldStart = true;
  let afterQuote = false;
  let delimiter = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') index++;
      else if (char === '"') {
        quoted = false;
        afterQuote = true;
      }
      continue;
    }
    if (char === "," || char === ";" || char === "\t") {
      delimiter = true;
      fieldStart = true;
      afterQuote = false;
      continue;
    }
    if (char === "\n" || char === "\r") {
      fieldStart = true;
      afterQuote = false;
      continue;
    }
    if (afterQuote) return false;
    if (char === '"') {
      if (!fieldStart) return false;
      quoted = true;
      fieldStart = false;
    } else {
      fieldStart = false;
    }
  }
  return delimiter && !quoted;
}

function isHtml(text: string): boolean {
  const source = text.replace(/^\uFEFF/, "").trimStart();
  return /^(?:<!doctype\s+html\b[^>]*>\s*)?(?:<!--[^]*?-->\s*)*<(?:html|head|body|title|article|main|section|div|p|h[1-6]|table|ul|ol|form|a|span|br|img|meta|script|style)\b[^>]*>/i.test(source);
}

function isXml(text: string): boolean {
  const source = text.replace(/^\uFEFF/, "").trim();
  const root = source.match(/^(?:<\?xml\s[^?]*\?>\s*)?<([A-Za-z_][\w.:-]*)(?:\s[^<>]*?)?>/);
  return root !== null && source.includes(`</${root[1]}>`);
}

function extensionOf(filename: string): string {
  const name = filename.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function looksLikeUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.length === 0 || bytes.includes(0)) return false;
  return decodeUtf8(bytes) !== null;
}
