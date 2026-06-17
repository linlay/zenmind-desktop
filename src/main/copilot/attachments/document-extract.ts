import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { XMLParser } from "fast-xml-parser";
import JSZip from "jszip";
import type {
  AssistantAttachmentDocument,
  AssistantDocumentFormat,
  AssistantDocumentReadStatus
} from "../../../shared/contracts";
import { t } from "../../i18n/main-i18n";

const DEFAULT_MAX_CHARS = 20000;
const TEXT_PREVIEW_BYTES = 512 * 1024;
const MAX_XLSX_ROWS_PER_SHEET = 120;
const MAX_XLSX_COLUMNS_PER_ROW = 40;
const MAX_ZIP_TEXT_FILES = 24;
const DEFAULT_PDF_RENDER_MAX_PAGES = 4;
const DEFAULT_PDF_RENDER_MAX_WIDTH = 1400;

const TEXT_EXTENSIONS = new Set([
  ".astro",
  ".bash",
  ".bat",
  ".c",
  ".cc",
  ".cfg",
  ".clj",
  ".conf",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".dart",
  ".env",
  ".go",
  ".h",
  ".hpp",
  ".htm",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsonl",
  ".jsx",
  ".kt",
  ".less",
  ".log",
  ".lua",
  ".md",
  ".mjs",
  ".php",
  ".plist",
  ".prisma",
  ".properties",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".svelte",
  ".svg",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".xml",
  ".yaml",
  ".yml",
  ".zsh"
]);

const ZIP_ARCHIVE_EXTENSIONS = new Set([".7z", ".gz", ".rar", ".tar", ".tgz", ".zip"]);

export type DocumentExtractResult = {
  text: string;
  truncated: boolean;
  error?: string;
  errorCode?: string;
  document: AssistantAttachmentDocument;
};

export type RenderedPdfPageImage = {
  pageNumber: number;
  name: string;
  mimeType: "image/png";
  buffer: Buffer;
  dataUrl: string;
};

type ExtractOptions = {
  maxChars?: number;
  mimeType?: string;
};

type ExtractedText = {
  text: string;
  format: AssistantDocumentFormat;
  pageCount?: number;
  sheetNames?: string[];
  slideCount?: number;
};

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  processEntities: true,
  trimValues: false
});

function clampMaxChars(value: number | undefined) {
  if (!Number.isFinite(value) || !value) {
    return DEFAULT_MAX_CHARS;
  }
  return Math.min(Math.max(Math.floor(value), 1000), 200000);
}

function createResult({
  text,
  format,
  maxChars,
  error,
  errorCode,
  pageCount,
  sheetNames,
  slideCount,
  readStatus
}: {
  text: string;
  format: AssistantDocumentFormat;
  maxChars: number;
  error?: string;
  errorCode?: string;
  pageCount?: number;
  sheetNames?: string[];
  slideCount?: number;
  readStatus?: AssistantDocumentReadStatus;
}): DocumentExtractResult {
  const normalizedText = text.replace(/\u0000/gu, "").trim();
  const truncated = normalizedText.length > maxChars;
  const outputText = truncated ? normalizedText.slice(0, maxChars) : normalizedText;
  const finalStatus: AssistantDocumentReadStatus =
    readStatus ?? (outputText ? (truncated ? "truncated" : "readable") : "unreadable");
  const document: AssistantAttachmentDocument = {
    format,
    readStatus: finalStatus,
    extractedChars: normalizedText.length,
    truncated,
    ...(pageCount !== undefined ? { pageCount } : {}),
    ...(sheetNames !== undefined ? { sheetNames } : {}),
    ...(slideCount !== undefined ? { slideCount } : {}),
    ...(errorCode ? { errorCode } : {})
  };
  return {
    text: outputText,
    truncated,
    ...(error ? { error } : {}),
    ...(errorCode ? { errorCode } : {}),
    document
  };
}

export function createImageDocumentMetadata(input: {
  readable: boolean;
  error?: string;
  errorCode?: string;
}): DocumentExtractResult {
  const document: AssistantAttachmentDocument = {
    format: "image",
    readStatus: input.readable ? "readable" : "unreadable",
    extractedChars: 0,
    truncated: false,
    imageMode: "vision",
    ...(input.errorCode ? { errorCode: input.errorCode } : {})
  };
  return {
    text: "",
    truncated: false,
    ...(input.error ? { error: input.error } : {}),
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    document
  };
}

function formatFromPath(filePath: string, mimeType?: string): AssistantDocumentFormat {
  const extension = path.extname(filePath).toLowerCase();
  if (mimeType?.startsWith("text/") || TEXT_EXTENSIONS.has(extension)) {
    return "text";
  }
  switch (extension) {
    case ".pdf":
      return "pdf";
    case ".docx":
      return "docx";
    case ".xlsx":
      return "xlsx";
    case ".pptx":
      return "pptx";
    case ".zip":
      return "zip";
    default:
      return "binary";
  }
}

function looksLikeText(buffer: Buffer) {
  if (buffer.includes(0)) {
    return false;
  }
  if (buffer.length === 0) {
    return true;
  }
  let suspicious = 0;
  for (const byte of buffer) {
    if (byte < 7 || (byte > 14 && byte < 32)) {
      suspicious += 1;
    }
  }
  return suspicious / buffer.length < 0.02;
}

function readUtf8Text(filePath: string) {
  const stat = fs.statSync(filePath);
  const bytesToRead = Math.min(stat.size, TEXT_PREVIEW_BYTES);
  const descriptor = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const bytesRead = fs.readSync(descriptor, buffer, 0, bytesToRead, 0);
    const slice = buffer.subarray(0, bytesRead);
    if (!TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase()) && !looksLikeText(slice)) {
      throw Object.assign(new Error(t("attachment.document.notUtf8Text")), {
        code: "unsupported_binary"
      });
    }
    return slice.toString("utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function installPdfJsTextExtractionPolyfills() {
  const target = globalThis as Record<string, unknown>;
  if (!target.DOMMatrix) {
    target.DOMMatrix = class MinimalDOMMatrix {
      a = 1;
      b = 0;
      c = 0;
      d = 1;
      e = 0;
      f = 0;

      constructor(init?: unknown) {
        if (Array.isArray(init) && init.length >= 6) {
          [this.a, this.b, this.c, this.d, this.e, this.f] = init.slice(0, 6).map(Number);
        }
      }

      multiplySelf() {
        return this;
      }

      preMultiplySelf() {
        return this;
      }

      translate() {
        return this;
      }

      scale() {
        return this;
      }

      invertSelf() {
        return this;
      }
    };
  }
  if (!target.ImageData) {
    target.ImageData = class MinimalImageData {
      constructor(
        public data: Uint8ClampedArray,
        public width: number,
        public height: number
      ) {}
    };
  }
  if (!target.Path2D) {
    target.Path2D = class MinimalPath2D {
      addPath() {}
    };
  }
}

async function readPdf(filePath: string): Promise<ExtractedText> {
  installPdfJsTextExtractionPolyfills();
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const buffer = fs.readFileSync(filePath);
  const data = new Uint8Array(buffer);
  const loadingTask = pdfjs.getDocument({
    data,
    disableWorker: true,
    useSystemFonts: true
  } as unknown as Parameters<typeof pdfjs.getDocument>[0]);
  const document = await loadingTask.promise;
  try {
    const pages: string[] = [];
    for (let pageIndex = 1; pageIndex <= document.numPages; pageIndex += 1) {
      const page = await document.getPage(pageIndex);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item: unknown) => {
          if (item && typeof item === "object" && "str" in item) {
            return String((item as { str?: string }).str ?? "");
          }
          return "";
        })
        .filter(Boolean)
        .join(" ");
      if (pageText.trim()) {
        pages.push(`Page ${pageIndex}\n${pageText}`);
      }
    }
    const text = pages.join("\n\n");
    const rawText = extractRawPdfLiteralText(buffer);
    return {
      text: shouldPreferRawPdfText(text, rawText) ? rawText : text,
      format: "pdf",
      pageCount: document.numPages
    };
  } finally {
    await document.destroy();
  }
}

export async function renderPdfPagesForVision(
  filePath: string,
  options: { maxPages?: number; maxWidth?: number } = {}
): Promise<RenderedPdfPageImage[]> {
  installPdfJsTextExtractionPolyfills();
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { createCanvas } = await import("@napi-rs/canvas");
  const buffer = fs.readFileSync(filePath);
  const data = new Uint8Array(buffer);
  const loadingTask = pdfjs.getDocument({
    data,
    disableWorker: true,
    useSystemFonts: true
  } as unknown as Parameters<typeof pdfjs.getDocument>[0]);
  const document = await loadingTask.promise;
  try {
    const maxPages = Math.min(
      Math.max(Math.floor(options.maxPages ?? DEFAULT_PDF_RENDER_MAX_PAGES), 1),
      document.numPages
    );
    const maxWidth = Math.max(Math.floor(options.maxWidth ?? DEFAULT_PDF_RENDER_MAX_WIDTH), 600);
    const images: RenderedPdfPageImage[] = [];
    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = Math.min(Math.max(maxWidth / baseViewport.width, 1), 2);
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const canvasContext = canvas.getContext("2d");
      await page.render({
        canvasContext,
        viewport
      } as unknown as Parameters<typeof page.render>[0]).promise;
      const imageBuffer = canvas.toBuffer("image/png");
      images.push({
        pageNumber,
        name: `${path.basename(filePath)}-page-${pageNumber}.png`,
        mimeType: "image/png",
        buffer: imageBuffer,
        dataUrl: `data:image/png;base64,${imageBuffer.toString("base64")}`
      });
      page.cleanup();
    }
    return images;
  } finally {
    await document.destroy();
  }
}

function decodePdfLiteralString(value: string) {
  let binary = "";
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      switch (char) {
        case "n":
          binary += "\n";
          break;
        case "r":
          binary += "\r";
          break;
        case "t":
          binary += "\t";
          break;
        case "b":
          binary += "\b";
          break;
        case "f":
          binary += "\f";
          break;
        default:
          binary += char;
          break;
      }
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else {
      binary += char;
    }
  }
  const bytes = Buffer.from(binary, "binary");
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let output = "";
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      output += String.fromCharCode((bytes[index] << 8) | bytes[index + 1]);
    }
    return output;
  }
  return bytes.toString("utf8");
}

function extractRawPdfLiteralText(buffer: Buffer) {
  const source = buffer.toString("latin1");
  const chunks: string[] = [];
  const literalPattern = /\(((?:\\.|[^\\()])*)\)\s*Tj/giu;
  let match: RegExpExecArray | null;
  while ((match = literalPattern.exec(source))) {
    const decoded = decodePdfLiteralString(match[1]).trim();
    if (decoded) {
      chunks.push(decoded);
    }
  }
  return chunks.join("\n\n");
}

function hasCjk(value: string) {
  return /[\u3400-\u9fff]/u.test(value);
}

function shouldPreferRawPdfText(pdfjsText: string, rawText: string) {
  return Boolean(rawText.trim() && hasCjk(rawText) && !hasCjk(pdfjsText));
}

function collectXmlText(value: unknown, names: Set<string>, output: string[]) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectXmlText(item, names, output);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const localName = key.includes(":") ? key.split(":").pop() ?? key : key;
    if (names.has(key) || names.has(localName)) {
      if (typeof child === "string" || typeof child === "number" || typeof child === "boolean") {
        output.push(String(child));
        continue;
      }
      if (Array.isArray(child)) {
        for (const item of child) {
          if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
            output.push(String(item));
          } else {
            collectXmlText(item, names, output);
          }
        }
        continue;
      }
    }
    collectXmlText(child, names, output);
  }
}

async function readZipXmlText(zip: JSZip, fileName: string, textNodeNames: Set<string>) {
  const entry = zip.file(fileName);
  if (!entry) {
    return "";
  }
  const xml = await entry.async("text");
  const parsed = xmlParser.parse(xml);
  const text: string[] = [];
  collectXmlText(parsed, textNodeNames, text);
  return text.join("\n").replace(/\n{3,}/gu, "\n\n");
}

async function readDocx(filePath: string): Promise<ExtractedText> {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const text = await readZipXmlText(zip, "word/document.xml", new Set(["w:t", "t"]));
  return {
    text,
    format: "docx"
  };
}

function slideIndex(fileName: string) {
  const match = /slide(\d+)\.xml$/iu.exec(fileName);
  return match ? Number.parseInt(match[1], 10) : Number.POSITIVE_INFINITY;
}

async function readPptx(filePath: string): Promise<ExtractedText> {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const slideNames = Object.keys(zip.files)
    .filter((fileName) => /^ppt\/slides\/slide\d+\.xml$/iu.test(fileName))
    .sort((a, b) => slideIndex(a) - slideIndex(b));
  const slides: string[] = [];
  for (const [index, slideName] of slideNames.entries()) {
    const text = await readZipXmlText(zip, slideName, new Set(["a:t", "t"]));
    if (text.trim()) {
      slides.push(`Slide ${index + 1}\n${text}`);
    }
  }
  return {
    text: slides.join("\n\n"),
    format: "pptx",
    slideCount: slideNames.length
  };
}

function formatCellValue(value: ExcelJS.CellValue) {
  if (value === null || value === undefined) {
    return "";
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "object") {
    if ("text" in value && typeof value.text === "string") {
      return value.text;
    }
    if ("result" in value) {
      return formatCellValue(value.result as ExcelJS.CellValue);
    }
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text).join("");
    }
    if ("hyperlink" in value && "text" in value && typeof value.text === "string") {
      return value.text;
    }
    return JSON.stringify(value);
  }
  return String(value);
}

async function readXlsx(filePath: string): Promise<ExtractedText> {
  const workbook = new ExcelJS.Workbook();
  const data = fs.readFileSync(filePath) as unknown as Parameters<typeof workbook.xlsx.load>[0];
  await workbook.xlsx.load(data);
  const sheetNames: string[] = [];
  const sections: string[] = [];
  workbook.eachSheet((worksheet) => {
    sheetNames.push(worksheet.name);
    const rows: string[] = [];
    let rowCount = 0;
    worksheet.eachRow((row) => {
      if (rowCount >= MAX_XLSX_ROWS_PER_SHEET) {
        return;
      }
      const values: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        if (colNumber <= MAX_XLSX_COLUMNS_PER_ROW) {
          values.push(formatCellValue(cell.value));
        }
      });
      if (values.some((value) => value.trim())) {
        rows.push(values.join("\t").replace(/\t+$/u, ""));
      }
      rowCount += 1;
    });
    sections.push(`Sheet: ${worksheet.name}\n${rows.join("\n")}`);
  });
  return {
    text: sections.join("\n\n"),
    format: "xlsx",
    sheetNames
  };
}

function isTextEntry(fileName: string) {
  return TEXT_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

async function readZip(filePath: string): Promise<ExtractedText> {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const sections: string[] = [];
  let textFileCount = 0;
  for (const [fileName, entry] of Object.entries(zip.files)) {
    if (entry.dir || ZIP_ARCHIVE_EXTENSIONS.has(path.extname(fileName).toLowerCase()) || !isTextEntry(fileName)) {
      continue;
    }
    const buffer = await entry.async("nodebuffer");
    if (!looksLikeText(buffer)) {
      continue;
    }
    const text = buffer.toString("utf8").replace(/\u0000/gu, "").trim();
    if (!text) {
      continue;
    }
    textFileCount += 1;
    sections.push(`File: ${fileName}\n${text}`);
    if (textFileCount >= MAX_ZIP_TEXT_FILES) {
      break;
    }
  }
  const intro = textFileCount > 0
    ? t("attachment.document.zipTextList", {
      files: sections.map((section) => section.split("\n", 1)[0].replace(/^File: /u, "")).join(t("common.nameSeparator"))
    })
    : "";
  return {
    text: [intro, ...sections].filter(Boolean).join("\n\n"),
    format: "zip"
  };
}

async function extractReadableText(filePath: string, format: AssistantDocumentFormat): Promise<ExtractedText> {
  switch (format) {
    case "text":
      return {
        text: readUtf8Text(filePath),
        format
      };
    case "pdf":
      return readPdf(filePath);
    case "docx":
      return readDocx(filePath);
    case "xlsx":
      return readXlsx(filePath);
    case "pptx":
      return readPptx(filePath);
    case "zip":
      return readZip(filePath);
    case "image":
    case "binary":
    default:
      throw Object.assign(new Error(t("attachment.document.unsupportedBinary")), {
        code: "unsupported_binary"
      });
  }
}

function unreadableMessage(errorCode: string) {
  switch (errorCode) {
    case "scanned_pdf_no_text":
      return t("attachment.document.scannedPdfNoText");
    case "unsupported_binary":
      return t("attachment.document.savedUnsupportedBinary");
    case "empty_document":
      return t("attachment.document.savedEmpty");
    default:
      return t("attachment.document.savedUnreadable");
  }
}

function errorCodeFromError(error: unknown) {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return "parse_failed";
}

export async function extractDocumentTextFromFile(
  filePath: string,
  options: ExtractOptions = {}
): Promise<DocumentExtractResult> {
  const maxChars = clampMaxChars(options.maxChars);
  const format = formatFromPath(filePath, options.mimeType);
  if (format === "binary") {
    return createResult({
      text: "",
      format,
      maxChars,
      error: unreadableMessage("unsupported_binary"),
      errorCode: "unsupported_binary",
      readStatus: "unreadable"
    });
  }

  try {
    const extracted = await extractReadableText(filePath, format);
    const emptyCode = extracted.format === "pdf" ? "scanned_pdf_no_text" : "empty_document";
    return createResult({
      text: extracted.text,
      format: extracted.format,
      maxChars,
      pageCount: extracted.pageCount,
      sheetNames: extracted.sheetNames,
      slideCount: extracted.slideCount,
      ...(extracted.text.trim()
        ? {}
        : {
            error: unreadableMessage(emptyCode),
            errorCode: emptyCode,
            readStatus: "unreadable" as const
          })
    });
  } catch (error) {
    const errorCode = errorCodeFromError(error);
    return createResult({
      text: "",
      format,
      maxChars,
      error: unreadableMessage(errorCode),
      errorCode,
      readStatus: "unreadable"
    });
  }
}
