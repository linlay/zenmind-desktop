import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType
} from "docx";
import ExcelJS from "exceljs";
import PptxGenJS from "pptxgenjs";
import { resolveDesktopToolPath } from "./desktop-tools";

export type OfficeContentFormat = "plain" | "markdown" | "html";

type OfficeOutputInput = {
  path?: string;
  filename?: string;
  title?: string;
  overwrite?: boolean;
};

export type OfficeToolResult = {
  path: string;
  requestedPath: string;
  sizeBytes: number;
  mimeType: string;
  overwritten: boolean;
  renamed: boolean;
};

export type DocxCreateInput = OfficeOutputInput & {
  content?: string;
  contentFormat?: Exclude<OfficeContentFormat, "html">;
};

export type PdfCreateInput = OfficeOutputInput & {
  content?: string;
  contentFormat?: OfficeContentFormat;
};

export type XlsxSheetInput = {
  name?: string;
  headers?: unknown[];
  rows?: unknown[][];
};

export type XlsxCreateInput = OfficeOutputInput & {
  sheets?: XlsxSheetInput[];
  content?: string;
};

export type PptxSlideInput = {
  title?: string;
  body?: string;
  bullets?: unknown[];
};

export type PptxCreateInput = OfficeOutputInput & {
  slides?: PptxSlideInput[];
  content?: string;
};

export type PdfRenderOptions = {
  title?: string;
};

export type PdfRenderer = (html: string, options?: PdfRenderOptions) => Promise<Buffer>;

export const OFFICE_MIME_TYPES = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
} as const;

const EXTENSION_BY_KIND = {
  docx: ".docx",
  pdf: ".pdf",
  xlsx: ".xlsx",
  pptx: ".pptx"
} as const;

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function uniqueDestination(target: string) {
  if (!fs.existsSync(target)) {
    return target;
  }
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  for (let index = 1; index < 1000; index += 1) {
    const candidate = path.join(dir, `${base} ${index}${ext}`);
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`无法生成不冲突的目标文件名：${target}`);
}

function resolveOfficeOutputPath(
  app: App,
  input: OfficeOutputInput,
  extension: string,
  chatId?: string | null
) {
  const rawPath = String(input.path ?? "").trim();
  const rawFilename = String(input.filename ?? "").trim();
  if (!rawPath && !rawFilename) {
    throw new Error("生成 Office 文件需要 path 或 filename。");
  }

  let resolved = "";
  if (rawPath && rawFilename) {
    const resolvedPath = resolveDesktopToolPath(app, rawPath, chatId);
    const shouldJoinFilename = fs.existsSync(resolvedPath)
      ? fs.statSync(resolvedPath).isDirectory()
      : !path.extname(resolvedPath);
    resolved = shouldJoinFilename
      ? resolveDesktopToolPath(app, path.join(resolvedPath, rawFilename), chatId)
      : resolvedPath;
  } else {
    resolved = resolveDesktopToolPath(app, rawPath || rawFilename, chatId);
  }

  const currentExtension = path.extname(resolved);
  if (!currentExtension) {
    resolved = `${resolved}${extension}`;
  } else if (currentExtension.toLowerCase() !== extension) {
    throw new Error(`文件扩展名必须是 ${extension}：${resolved}`);
  }
  return resolved;
}

function writeOfficeBuffer(
  app: App,
  input: OfficeOutputInput,
  kind: keyof typeof EXTENSION_BY_KIND,
  buffer: Buffer,
  chatId?: string | null
): OfficeToolResult {
  const requestedPath = resolveOfficeOutputPath(app, input, EXTENSION_BY_KIND[kind], chatId);
  if (fs.existsSync(requestedPath) && fs.statSync(requestedPath).isDirectory()) {
    throw new Error(`写入目标是目录，请提供文件名：${requestedPath}`);
  }
  const existedBefore = fs.existsSync(requestedPath);
  const finalPath = existedBefore && !input.overwrite ? uniqueDestination(requestedPath) : requestedPath;
  ensureDir(path.dirname(finalPath));
  fs.writeFileSync(finalPath, buffer);
  const stat = fs.statSync(finalPath);
  return {
    path: finalPath,
    requestedPath,
    sizeBytes: stat.size,
    mimeType: OFFICE_MIME_TYPES[kind],
    overwritten: existedBefore && Boolean(input.overwrite),
    renamed: existedBefore && !input.overwrite
  };
}

function normalizeText(value: unknown) {
  return typeof value === "string" ? value : String(value ?? "");
}

function parseMarkdownTable(lines: string[], start: number) {
  const rows: string[][] = [];
  let index = start;
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.includes("|")) {
      break;
    }
    const cells = line
      .trim()
      .replace(/^\|/u, "")
      .replace(/\|$/u, "")
      .split("|")
      .map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-{3,}:?$/u.test(cell))) {
      continue;
    }
    rows.push(cells);
  }
  return { rows, nextIndex: index };
}

function buildDocxChildren(title: string | undefined, content: string, contentFormat: DocxCreateInput["contentFormat"]) {
  const children: Array<Paragraph | Table> = [];
  if (title) {
    children.push(new Paragraph({
      text: title,
      heading: HeadingLevel.TITLE
    }));
  }

  const lines = content.split(/\r?\n/u);
  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }

    if (contentFormat === "markdown") {
      const heading = trimmed.match(/^(#{1,3})\s+(.+)$/u);
      if (heading) {
        const level = heading[1].length;
        children.push(new Paragraph({
          text: heading[2],
          heading: level === 1 ? HeadingLevel.HEADING_1 : level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3
        }));
        index += 1;
        continue;
      }
      const bullet = trimmed.match(/^[-*]\s+(.+)$/u);
      if (bullet) {
        children.push(new Paragraph({
          children: [new TextRun(bullet[1])],
          bullet: { level: 0 }
        }));
        index += 1;
        continue;
      }
      if (trimmed.includes("|")) {
        const table = parseMarkdownTable(lines, index);
        if (table.rows.length > 0) {
          children.push(new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: table.rows.map((row) => new TableRow({
              children: row.map((cell) => new TableCell({
                children: [new Paragraph(cell)]
              }))
            }))
          }));
          index = table.nextIndex;
          continue;
        }
      }
    }

    children.push(new Paragraph({
      children: [new TextRun(line)]
    }));
    index += 1;
  }

  if (children.length === 0) {
    children.push(new Paragraph(""));
  }
  return children;
}

export async function createDocxFile(app: App, input: DocxCreateInput, chatId?: string | null): Promise<OfficeToolResult> {
  const contentFormat = input.contentFormat === "markdown" ? "markdown" : "plain";
  const doc = new Document({
    sections: [{
      children: buildDocxChildren(input.title, normalizeText(input.content), contentFormat)
    }]
  });
  const buffer = await Packer.toBuffer(doc);
  return writeOfficeBuffer(app, input, "docx", buffer, chatId);
}

function escapeHtml(value: string) {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

function markdownToHtml(content: string) {
  const output: string[] = [];
  const lines = content.split(/\r?\n/u);
  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }
    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/u);
    if (heading) {
      const level = heading[1].length;
      output.push(`<h${level}>${escapeHtml(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }
    const bullets: string[] = [];
    while (index < lines.length) {
      const bullet = (lines[index] ?? "").trim().match(/^[-*]\s+(.+)$/u);
      if (!bullet) {
        break;
      }
      bullets.push(`<li>${escapeHtml(bullet[1])}</li>`);
      index += 1;
    }
    if (bullets.length > 0) {
      output.push(`<ul>${bullets.join("")}</ul>`);
      continue;
    }
    if (trimmed.includes("|")) {
      const table = parseMarkdownTable(lines, index);
      if (table.rows.length > 0) {
        output.push([
          "<table>",
          ...table.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`),
          "</table>"
        ].join(""));
        index = table.nextIndex;
        continue;
      }
    }
    output.push(`<p>${escapeHtml(line)}</p>`);
    index += 1;
  }
  return output.join("\n");
}

function buildPdfHtml(input: PdfCreateInput) {
  const title = normalizeText(input.title);
  const content = normalizeText(input.content);
  const body = input.contentFormat === "html"
    ? content
    : input.contentFormat === "markdown"
      ? markdownToHtml(content)
      : content.split(/\r?\n/u).filter((line) => line.trim()).map((line) => `<p>${escapeHtml(line)}</p>`).join("\n");

  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    "<meta charset=\"utf-8\" />",
    `<title>${escapeHtml(title || "ZenMind PDF")}</title>`,
    "<style>",
    "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;margin:48px;color:#111827;line-height:1.6;font-size:14px;}",
    "h1{font-size:28px;margin:0 0 24px;}h2{font-size:22px;margin:24px 0 12px;}h3{font-size:18px;margin:20px 0 10px;}",
    "p{margin:0 0 12px;}ul{margin:0 0 12px 22px;padding:0;}table{border-collapse:collapse;width:100%;margin:16px 0;}td,th{border:1px solid #d1d5db;padding:8px;}",
    "</style>",
    "</head>",
    "<body>",
    title ? `<h1>${escapeHtml(title)}</h1>` : "",
    body || "<p></p>",
    "</body>",
    "</html>"
  ].join("");
}

export async function createPdfFile(
  app: App,
  input: PdfCreateInput,
  chatId?: string | null,
  options: { renderPdf?: PdfRenderer } = {}
): Promise<OfficeToolResult> {
  if (!options.renderPdf) {
    throw new Error("当前版本没有配置 PDF 渲染能力。");
  }
  const html = buildPdfHtml(input);
  const buffer = await options.renderPdf(html, { title: input.title });
  if (!buffer.subarray(0, 5).toString("ascii").startsWith("%PDF-")) {
    throw new Error("PDF 渲染器没有返回有效 PDF。");
  }
  return writeOfficeBuffer(app, input, "pdf", buffer, chatId);
}

function normalizeSheetName(name: unknown, index: number) {
  const raw = normalizeText(name).trim() || `Sheet ${index + 1}`;
  return raw.replace(/[\\/*?:[\]]/gu, "_").slice(0, 31) || `Sheet ${index + 1}`;
}

function normalizeRows(rows: unknown): unknown[][] {
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows.map((row) => Array.isArray(row) ? row : [row]);
}

export async function createXlsxFile(app: App, input: XlsxCreateInput, chatId?: string | null): Promise<OfficeToolResult> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "ZenMind";
  workbook.created = new Date();
  workbook.modified = new Date();
  const rawSheets = Array.isArray(input.sheets) && input.sheets.length > 0
    ? input.sheets
    : [{ name: input.title || "Sheet 1", rows: normalizeText(input.content).split(/\r?\n/u).filter(Boolean).map((line) => [line]) }];

  rawSheets.forEach((sheet, index) => {
    const worksheet = workbook.addWorksheet(normalizeSheetName(sheet?.name, index));
    const headers = Array.isArray(sheet?.headers) ? sheet.headers : [];
    if (headers.length > 0) {
      worksheet.addRow(headers);
      worksheet.getRow(1).font = { bold: true };
    }
    const rows = normalizeRows(sheet?.rows);
    rows.forEach((row) => worksheet.addRow(row));
    worksheet.columns.forEach((column) => {
      let maxLength = 10;
      column.eachCell?.({ includeEmpty: false }, (cell) => {
        maxLength = Math.max(maxLength, normalizeText(cell.value).length + 2);
      });
      column.width = Math.min(maxLength, 40);
    });
  });

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return writeOfficeBuffer(app, input, "xlsx", buffer, chatId);
}

function normalizeSlides(input: PptxCreateInput): PptxSlideInput[] {
  if (Array.isArray(input.slides) && input.slides.length > 0) {
    return input.slides;
  }
  return [{
    title: input.title || "ZenMind",
    body: normalizeText(input.content)
  }];
}

export async function createPptxFile(app: App, input: PptxCreateInput, chatId?: string | null): Promise<OfficeToolResult> {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "ZenMind";
  pptx.subject = input.title || "ZenMind presentation";
  pptx.title = input.title || "ZenMind";
  pptx.company = "ZenMind";
  pptx.theme = {
    headFontFace: "Aptos Display",
    bodyFontFace: "Aptos"
  };

  for (const slideInput of normalizeSlides(input)) {
    const slide = pptx.addSlide();
    slide.background = { color: "FFFFFF" };
    const title = normalizeText(slideInput.title || input.title || "ZenMind");
    slide.addText(title, {
      x: 0.65,
      y: 0.45,
      w: 11.0,
      h: 0.65,
      fontFace: "Aptos Display",
      fontSize: 30,
      bold: true,
      color: "111827",
      margin: 0
    });
    const body = normalizeText(slideInput.body);
    if (body) {
      slide.addText(body, {
        x: 0.75,
        y: 1.35,
        w: 11.0,
        h: 1.2,
        fontFace: "Aptos",
        fontSize: 18,
        color: "374151",
        breakLine: false,
        fit: "shrink"
      });
    }
    const bullets = Array.isArray(slideInput.bullets) ? slideInput.bullets.map(normalizeText).filter(Boolean) : [];
    if (bullets.length > 0) {
      slide.addText(bullets.map((text) => ({ text, options: { bullet: { indent: 18 }, breakLine: true } })), {
        x: 0.95,
        y: body ? 2.7 : 1.45,
        w: 10.5,
        h: 3.6,
        fontFace: "Aptos",
        fontSize: 18,
        color: "111827",
        fit: "shrink"
      });
    }
  }

  const output = await pptx.write({ outputType: "nodebuffer" });
  return writeOfficeBuffer(app, input, "pptx", Buffer.from(output as Buffer), chatId);
}
