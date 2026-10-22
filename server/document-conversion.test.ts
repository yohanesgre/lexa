import { describe, expect, it } from "vitest";
import { convertDocumentToMarkdown, type ManagedMarkdownBinding } from "./document-conversion";

const PDF = new TextEncoder().encode("%PDF-1.7 fixture");


describe("managed document conversion failures", () => {
  it("fails explicitly when Workers AI binding is missing", async () => {
    await expect(convertDocumentToMarkdown(PDF, "application/pdf", "file.pdf"))
      .rejects.toThrow("Workers AI binding AI is not configured");
  });

  it("surfaces per-file service errors and empty results", async () => {
    await expect(convertDocumentToMarkdown(PDF, "application/pdf", "file.pdf", {
      toMarkdown: async () => [{
        format: "error",
        error: "Invalid PDF",
        name: "file.pdf",
        mimetype: "application/pdf",
        id: "conversion-id",
      }],
    })).rejects.toThrow("Invalid PDF");
    await expect(convertDocumentToMarkdown(PDF, "application/pdf", "file.pdf", {
      toMarkdown: async () => [],
    })).rejects.toThrow("service returned no unique result");
    await expect(convertDocumentToMarkdown(PDF, "application/pdf", "file.pdf", {
      toMarkdown: async () => [{
        format: "markdown",
        data: "  \n",
        name: "file.pdf",
        mimetype: "application/pdf",
        id: "conversion-id",
      }],
    })).rejects.toThrow("empty or invalid content");
  });

  it("surfaces thrown service errors without fallback", async () => {
    const binding: ManagedMarkdownBinding = { toMarkdown: async () => { throw new Error("service offline"); } };
    await expect(convertDocumentToMarkdown(PDF, "application/pdf", "file.pdf", binding))
      .rejects.toThrow("Document conversion failed: service offline");
  });

  it("returns successful managed Markdown result", async () => {
    const binding: ManagedMarkdownBinding = {
      toMarkdown: async () => [{
        format: "markdown",
        data: "# Converted",
        name: "file.pdf",
        mimetype: "application/pdf",
        id: "conversion-id",
      }],
    };
    await expect(convertDocumentToMarkdown(PDF, "application/pdf", "file.pdf", binding)).resolves.toBe("# Converted");
  });

  it("returns direct UTF-8 text unchanged without mutating input bytes", async () => {
    const original = new TextEncoder().encode("\uFEFF# Heading\r\n\r\nbody\n");
    const before = [...original];
    const markdown = await convertDocumentToMarkdown(original, "text/markdown", "notes.md");
    const plain = await convertDocumentToMarkdown(original, "text/plain", "notes.txt");
    expect(markdown).toBe("\uFEFF# Heading\r\n\r\nbody\n");
    expect(plain).toBe(markdown);
    expect([...original]).toEqual(before);
  });

  it("rejects invalid UTF-8 text rather than replacing bytes", async () => {
    await expect(convertDocumentToMarkdown(new Uint8Array([0xff]), "text/plain", "bad.txt"))
      .rejects.toThrow();
  });
});
