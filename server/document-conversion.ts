import { DOCUMENT_MIME, DOCUMENT_MIME_TYPES } from "../shared/document-formats";

export interface MarkdownConversionResult {
  format: "markdown" | "text" | "error";
  data?: string;
  error?: string;
  name: string;
  mimetype: string;
  id: string;
  tokens?: number;
}

export interface ManagedMarkdownBinding {
  toMarkdown(files: Array<{ name: string; blob: Blob }>): Promise<MarkdownConversionResult | MarkdownConversionResult[]>;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export async function convertDocumentToMarkdown(
  bytes: Uint8Array,
  mimeType: string,
  filename: string,
  binding?: ManagedMarkdownBinding,
): Promise<string> {
  if (mimeType === DOCUMENT_MIME.markdown || mimeType === DOCUMENT_MIME.text) {
    return UTF8.decode(bytes);
  }
  if (!binding) throw new Error("Document conversion unavailable: Workers AI binding AI is not configured");

  if (!DOCUMENT_MIME_TYPES.includes(mimeType)) {
    throw new Error(`Document conversion unavailable: unsupported MIME type '${mimeType}'`);
  }
  let results: MarkdownConversionResult | MarkdownConversionResult[];
  const body = bytes.buffer instanceof ArrayBuffer ? bytes as Uint8Array<ArrayBuffer> : new Uint8Array(bytes);
  try {
    results = await binding.toMarkdown([{
      name: filename,
      blob: new Blob([body], { type: mimeType }),
    }]);
  } catch (cause) {
    const detail = cause instanceof Error ? `: ${cause.message}` : "";
    throw new Error(`Document conversion failed${detail}`);
  }

  const resultList = Array.isArray(results) ? results : [results];
  if (resultList.length !== 1 || typeof resultList[0] !== "object" || resultList[0] === null
    || resultList[0].name !== filename) {
    throw new Error("Document conversion failed: service returned no unique result for input file");
  }
  const result = resultList[0];
  if (result.format === "error") {
    throw new Error(`Document conversion failed: ${result.error || "service reported an error"}`);
  }
  if ((result.format !== "markdown" && result.format !== "text") || typeof result.data !== "string" || result.data.trim() === "") {
    throw new Error("Document conversion failed: service returned empty or invalid content");
  }
  return result.data;
}
