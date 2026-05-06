import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ExcelJS = require("exceljs");
const {
  createDocxFile,
  createPdfFile,
  createPptxFile,
  createXlsxFile
} = require("../dist-electron/main/assistant/office-tools.js");
const { routeAssistantToolRequest } = require("../dist-electron/main/assistant/capability-broker.js");

function makeTempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-office-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeApp(root) {
  return {
    getPath(name) {
      if (name === "desktop") {
        return path.join(root, "Desktop");
      }
      if (name === "userData") {
        return path.join(root, "assistant");
      }
      return root;
    }
  };
}

function readFile(filePath) {
  return fs.readFileSync(filePath);
}

test("office tools create docx, pdf, xlsx, and pptx files under allowed roots", async (t) => {
  const root = makeTempRoot(t);
  const app = makeApp(root);
  fs.mkdirSync(path.join(root, "Desktop"), { recursive: true });

  const docx = await createDocxFile(app, {
    filename: "joke",
    title: "今日笑话",
    content: "# 标题\n\n- 第一条\n- 第二条",
    contentFormat: "markdown"
  });
  assert.equal(path.basename(docx.path), "joke.docx");
  assert.equal(docx.mimeType, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.ok(readFile(docx.path).includes(Buffer.from("word/document.xml")));

  const pdf = await createPdfFile(app, {
    filename: "report",
    title: "报告",
    content: "PDF 正文"
  }, null, {
    renderPdf: async (html) => {
      assert.match(html, /PDF 正文/);
      return Buffer.from("%PDF-1.4\n% test pdf\n", "utf8");
    }
  });
  assert.equal(path.basename(pdf.path), "report.pdf");
  assert.equal(pdf.mimeType, "application/pdf");
  assert.equal(readFile(pdf.path).subarray(0, 5).toString("ascii"), "%PDF-");

  const xlsx = await createXlsxFile(app, {
    filename: "scores",
    title: "成绩",
    sheets: [
      {
        name: "Sheet A",
        headers: ["姓名", "分数"],
        rows: [["Alice", 98], ["Bob", 88]]
      }
    ]
  });
  assert.equal(path.basename(xlsx.path), "scores.xlsx");
  assert.equal(xlsx.mimeType, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(xlsx.path);
  assert.equal(workbook.getWorksheet("Sheet A").getCell("A2").value, "Alice");
  assert.equal(workbook.getWorksheet("Sheet A").getCell("B3").value, 88);

  const pptx = await createPptxFile(app, {
    filename: "deck",
    title: "演示",
    slides: [
      { title: "第一页", body: "摘要", bullets: ["要点一", "要点二"] }
    ]
  });
  assert.equal(path.basename(pptx.path), "deck.pptx");
  assert.equal(pptx.mimeType, "application/vnd.openxmlformats-officedocument.presentationml.presentation");
  assert.ok(readFile(pptx.path).includes(Buffer.from("ppt/slides/slide1.xml")));
});

test("office tools deduplicate, overwrite, and reject unsafe output paths", async (t) => {
  const root = makeTempRoot(t);
  const app = makeApp(root);
  const desktop = path.join(root, "Desktop");
  fs.mkdirSync(desktop, { recursive: true });
  fs.writeFileSync(path.join(desktop, "report.docx"), "old", "utf8");

  const renamed = await createDocxFile(app, {
    filename: "report.docx",
    title: "新报告",
    content: "内容",
    overwrite: false
  });
  assert.equal(path.basename(renamed.path), "report 1.docx");
  assert.equal(renamed.renamed, true);

  const overwritten = await createDocxFile(app, {
    filename: "report.docx",
    title: "覆盖报告",
    content: "内容",
    overwrite: true
  });
  assert.equal(path.basename(overwritten.path), "report.docx");
  assert.equal(overwritten.overwritten, true);

  await assert.rejects(
    () => createPdfFile(app, {
      path: path.join(root, "outside.pdf"),
      content: "nope"
    }, null, {
      renderPdf: async () => Buffer.from("%PDF-1.4\n", "utf8")
    }),
    /允许范围/
  );

  await assert.rejects(
    () => createXlsxFile(app, {
      filename: "wrong.docx",
      sheets: [{ rows: [["bad"]] }]
    }),
    /扩展名/
  );
});

test("office creation tools are routed as approval-required file operations", () => {
  for (const toolName of ["desktop_create_docx", "desktop_create_pdf", "desktop_create_xlsx", "desktop_create_pptx"]) {
    const route = routeAssistantToolRequest({
      toolName,
      args: { filename: "demo" },
      platform: "darwin",
      permissionMode: "safe_default"
    });
    assert.equal(route.kind, "file_operation");
    assert.equal(route.riskLevel, "medium");
    assert.equal(route.requiresApproval, true);
  }
});
