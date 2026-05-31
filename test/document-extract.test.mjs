import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const JSZip = require("jszip");
const ExcelJS = require("exceljs");
const {
  extractDocumentTextFromFile
} = require("../dist-electron/main/copilot/attachments/document-extract.js");

function makeTempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-document-extract-test-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function makePdfBuffer(text) {
  const escaped = String(text).replace(/\\/gu, "\\\\").replace(/\(/gu, "\\(").replace(/\)/gu, "\\)");
  const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream`
  ];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(output, "utf8"));
    output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(output, "utf8");
  output += `xref\n0 ${objects.length + 1}\n`;
  output += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(output, "utf8");
}

async function writeDocx(filePath, text) {
  const zip = new JSZip();
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>${text}</w:t></w:r></w:p>
  </w:body>
</w:document>`);
  fs.writeFileSync(filePath, await zip.generateAsync({ type: "nodebuffer" }));
}

async function writePptx(filePath, text) {
  const zip = new JSZip();
  zip.file("ppt/slides/slide1.xml", `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`);
  fs.writeFileSync(filePath, await zip.generateAsync({ type: "nodebuffer" }));
}

async function writeXlsx(filePath, text) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Data");
  sheet.addRow(["标题", "内容"]);
  sheet.addRow(["示例", text]);
  await workbook.xlsx.writeFile(filePath);
}

async function writeZip(filePath, text) {
  const zip = new JSZip();
  zip.file("notes/readme.md", `# Readme\n${text}`);
  zip.file("nested/archive.zip", Buffer.from("nested zip skipped"));
  fs.writeFileSync(filePath, await zip.generateAsync({ type: "nodebuffer" }));
}

test("document extraction reads common uploaded file formats", async (t) => {
  const root = makeTempRoot(t);
  const cases = [
    ["note.md", Buffer.from("# 标题\n普通文本附件", "utf8"), "普通文本附件", "text"],
    ["report.pdf", makePdfBuffer("PDF 可复制文本内容"), "PDF 可复制文本内容", "pdf"],
    ["report.docx", null, "Word 文档正文内容", "docx"],
    ["table.xlsx", null, "Excel 表格正文内容", "xlsx"],
    ["slides.pptx", null, "PPT 幻灯片正文内容", "pptx"],
    ["bundle.zip", null, "ZIP 内部文本内容", "zip"]
  ];

  await writeDocx(path.join(root, "report.docx"), "Word 文档正文内容");
  await writeXlsx(path.join(root, "table.xlsx"), "Excel 表格正文内容");
  await writePptx(path.join(root, "slides.pptx"), "PPT 幻灯片正文内容");
  await writeZip(path.join(root, "bundle.zip"), "ZIP 内部文本内容");

  for (const [name, buffer, expected, format] of cases) {
    const filePath = path.join(root, name);
    if (buffer) {
      fs.writeFileSync(filePath, buffer);
    }
    const extracted = await extractDocumentTextFromFile(filePath, { maxChars: 20000 });
    assert.equal(extracted.document.format, format);
    assert.equal(extracted.document.readStatus, "readable");
    assert.match(extracted.text, new RegExp(expected));
  }
});

test("document extraction reports unreadable unknown binaries without hallucinating text", async (t) => {
  const root = makeTempRoot(t);
  const filePath = path.join(root, "unknown.bin");
  fs.writeFileSync(filePath, Buffer.from([0, 1, 2, 3, 4, 5]));

  const extracted = await extractDocumentTextFromFile(filePath, { maxChars: 20000 });
  assert.equal(extracted.text, "");
  assert.equal(extracted.document.format, "binary");
  assert.equal(extracted.document.readStatus, "unreadable");
  assert.equal(extracted.document.errorCode, "unsupported_binary");
});
