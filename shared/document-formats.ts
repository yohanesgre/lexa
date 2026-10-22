export const DOCUMENT_MIME = {
  pdf: "application/pdf",
  xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
  xlsb: "application/vnd.ms-excel.sheet.binary.macroEnabled.12",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  csv: "text/csv",
  html: "text/html",
  xml: "application/xml",
  markdown: "text/markdown",
  text: "text/plain",
} as const;

export const DOCUMENT_FORMATS = [
  { extension: ".pdf", mimeType: DOCUMENT_MIME.pdf },
  { extension: ".xls", mimeType: DOCUMENT_MIME.xls },
  { extension: ".docx", mimeType: DOCUMENT_MIME.docx },
  { extension: ".xlsx", mimeType: DOCUMENT_MIME.xlsx },
  { extension: ".xlsm", mimeType: DOCUMENT_MIME.xlsm },
  { extension: ".xlsb", mimeType: DOCUMENT_MIME.xlsb },
  { extension: ".odt", mimeType: DOCUMENT_MIME.odt },
  { extension: ".ods", mimeType: DOCUMENT_MIME.ods },
  { extension: ".csv", mimeType: DOCUMENT_MIME.csv },
  { extension: ".html", mimeType: DOCUMENT_MIME.html },
  { extension: ".htm", mimeType: DOCUMENT_MIME.html },
  { extension: ".xml", mimeType: DOCUMENT_MIME.xml },
  { extension: ".md", mimeType: DOCUMENT_MIME.markdown },
  { extension: ".markdown", mimeType: DOCUMENT_MIME.markdown },
  { extension: ".txt", mimeType: DOCUMENT_MIME.text },
] as const;

export const DOCUMENT_ACCEPT = DOCUMENT_FORMATS.map(({ extension }) => extension).join(",");

export const DOCUMENT_MIME_TYPES: readonly string[] = DOCUMENT_FORMATS.map(({ mimeType }) => mimeType).filter(
  (mimeType, index, types) => types.indexOf(mimeType) === index,
);
