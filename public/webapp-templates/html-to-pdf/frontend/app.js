const sampleHtml = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>示例周报</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; color: #1f2937; font-family: "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 13px; }
    h1 { margin: 0 0 8px; font-size: 24px; color: #12212b; }
    h2 { margin: 24px 0 10px; padding-bottom: 6px; border-bottom: 2px solid #176b4d; font-size: 16px; }
    .meta { color: #65717c; }
    .metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 20px 0; }
    .metric { padding: 14px; border: 1px solid #d9dfe4; border-radius: 6px; }
    .metric strong { display: block; margin-top: 6px; color: #176b4d; font-size: 22px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 9px 10px; border: 1px solid #dfe4e8; text-align: left; }
    th { background: #f2f5f4; }
    tr { break-inside: avoid; }
    .note { margin-top: 20px; padding: 12px; border-left: 3px solid #d89b22; background: #fff8e8; }
  </style>
</head>
<body>
  <h1>分支周度经营简报</h1>
  <div class="meta">统计周期：2026 年第 28 周 · 内部资料</div>
  <section class="metrics">
    <div class="metric">新增客户<strong>128</strong></div>
    <div class="metric">净入金<strong>2,460 万</strong></div>
    <div class="metric">客户权益<strong>8.3 亿</strong></div>
  </section>
  <h2>核心指标</h2>
  <table>
    <thead><tr><th>指标</th><th>本周</th><th>环比</th><th>目标完成率</th></tr></thead>
    <tbody>
      <tr><td>有效客户数</td><td>3,842</td><td>+3.1%</td><td>96%</td></tr>
      <tr><td>日均成交额</td><td>12.6 亿</td><td>+8.4%</td><td>108%</td></tr>
      <tr><td>手续费收入</td><td>86.2 万</td><td>-1.2%</td><td>91%</td></tr>
      <tr><td>重点品种覆盖</td><td>23 个</td><td>+2</td><td>104%</td></tr>
    </tbody>
  </table>
  <h2>本周工作与下周计划</h2>
  <p>完成重点产业客户回访，推进套期保值方案落地；下周重点跟进三个存量项目，并完成风险检查。</p>
  <div class="note">提示：导入完整 HTML 文件后，页面样式会参与分页；ECharts 图表会固化为 SVG，其余脚本及不安全嵌入内容不会执行。</div>
</body>
</html>`;

const elements = {
  source: document.querySelector("#source-editor"),
  preview: document.querySelector("#preview"),
  fileInput: document.querySelector("#file-input"),
  importButton: document.querySelector("#import-button"),
  exportButton: document.querySelector("#export-button"),
  resetButton: document.querySelector("#reset-button"),
  pageSize: document.querySelector("#page-size"),
  margin: document.querySelector("#page-margin"),
  marginValue: document.querySelector("#margin-value"),
  keepBackground: document.querySelector("#keep-background"),
  status: document.querySelector("#status"),
  pageCount: document.querySelector("#page-count"),
  documentMeta: document.querySelector("#document-meta"),
  zoom: document.querySelector("#zoom"),
  zoomValue: document.querySelector("#zoom-value")
};

let orientation = "portrait";
let currentFileName = "示例周报.html";
let renderSequence = 0;
let renderTimer = 0;
let stylesheetUrl = "";
const echartsWorkerUrl = new URL("vendor/echarts.min.js", location.href).toString();

function setStatus(message, type = "") {
  elements.status.textContent = message;
  elements.status.className = `toolbar-status${type ? ` is-${type}` : ""}`;
}

function sanitizeUrl(value, allowDataImage = false) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (allowDataImage && /^data:image\/(png|jpeg|gif|webp);base64,/iu.test(raw)) return raw;
  try {
    const parsed = new URL(raw, location.href);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function sanitizeCss(value) {
  return String(value || "")
    .replace(/@import[\s\S]*?;/giu, "")
    .replace(/url\((['"]?)(?!data:image\/)[\s\S]*?\1\)/giu, "none")
    .replace(/expression\s*\([^)]*\)/giu, "");
}

function extractEchartsJob(source) {
  const parsed = new DOMParser().parseFromString(source, "text/html");
  const scripts = [...parsed.querySelectorAll("script:not([src])")]
    .map((node) => node.textContent || "")
    .filter((value) => /\becharts\s*\./u.test(value));
  if (scripts.length === 0) return null;

  const dimensions = {};
  parsed.querySelectorAll("[id]").forEach((node) => {
    if (!scripts.some((script) => script.includes(`getElementById('${node.id}')`) || script.includes(`getElementById(\"${node.id}\")`))) return;
    dimensions[node.id] = {
      width: 620,
      height: node.classList.contains("tall") ? 320 : node.classList.contains("short") ? 220 : 280
    };
  });
  return { script: scripts.join("\n"), dimensions };
}

function renderEchartsInWorker(source) {
  const job = extractEchartsJob(source);
  if (!job) return Promise.resolve({ charts: {}, count: 0 });

  return new Promise((resolve, reject) => {
    const workerSource = `
      var window;
      var document;
      var navigator;
      importScripts(${JSON.stringify(echartsWorkerUrl)});
      const dimensions = ${JSON.stringify(job.dimensions)};
      const charts = Object.create(null);
      const instances = Object.create(null);
      const engine = self.echarts;
      self.fetch = () => Promise.reject(new Error("Network access is disabled"));
      self.XMLHttpRequest = undefined;
      self.WebSocket = undefined;
      self.EventSource = undefined;
      self.WebTransport = undefined;
      self.importScripts = () => { throw new Error("Loading additional scripts is disabled"); };
      document = {
        createElement(tagName) {
          if (String(tagName).toLowerCase() === "canvas") return new OffscreenCanvas(1, 1);
          return { style: {}, setAttribute() {}, appendChild() {} };
        },
        getElementById(id) { return { id: String(id) }; },
        querySelectorAll(selector) {
          return selector === ".chart" ? Object.keys(dimensions).map((id) => ({ id })) : [];
        }
      };
      window = { addEventListener() {} };
      const echarts = {
        init(dom) {
          const id = dom && String(dom.id || "");
          const size = dimensions[id] || { width: 620, height: 280 };
          const chart = engine.init(null, null, {
            renderer: "svg",
            ssr: true,
            width: size.width,
            height: size.height
          });
          const facade = {
            setOption(option) {
              chart.setOption(option);
              charts[id] = chart.renderToSVGString();
              return facade;
            },
            resize() {},
            dispose() { chart.dispose(); }
          };
          instances[id] = facade;
          return facade;
        },
        getInstanceByDom(dom) { return instances[dom && dom.id] || null; }
      };
      try {
        ${job.script}
        self.postMessage({ ok: true, charts });
      } catch (error) {
        self.postMessage({ ok: false, message: error && error.message ? error.message : String(error) });
      }
    `;
    const worker = new Worker(URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" })));
    const timeout = window.setTimeout(() => {
      worker.terminate();
      reject(new Error("图表脚本执行超时，已安全终止。"));
    }, 20000);
    worker.addEventListener("message", (event) => {
      window.clearTimeout(timeout);
      worker.terminate();
      if (!event.data?.ok) {
        reject(new Error(`ECharts 渲染失败：${event.data?.message || "未知错误"}`));
        return;
      }
      const charts = event.data.charts || {};
      resolve({ charts, count: Object.keys(charts).length });
    }, { once: true });
    worker.addEventListener("error", (event) => {
      window.clearTimeout(timeout);
      worker.terminate();
      reject(new Error(`ECharts 渲染失败：${event.message || "Worker 错误"}`));
    }, { once: true });
  });
}

function parseAndSanitize(source, renderedCharts = {}) {
  const parsed = new DOMParser().parseFromString(source, "text/html");
  const removedScriptCount = parsed.querySelectorAll("script").length;
  parsed.querySelectorAll("script, iframe, frame, object, embed, link, base, meta[http-equiv]").forEach((node) => node.remove());
  Object.entries(renderedCharts).forEach(([id, svg]) => {
    const container = parsed.getElementById(id);
    if (!container || typeof svg !== "string") return;
    container.innerHTML = svg;
    container.setAttribute("data-rendered-chart", "echarts");
  });
  parsed.querySelectorAll("*").forEach((node) => {
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || name === "srcdoc") {
        node.removeAttribute(attribute.name);
        continue;
      }
      if (["href", "action", "formaction", "poster"].includes(name)) {
        const safe = sanitizeUrl(attribute.value);
        safe ? node.setAttribute(attribute.name, safe) : node.removeAttribute(attribute.name);
      }
      if (name === "src") {
        const safe = sanitizeUrl(attribute.value, node.tagName === "IMG");
        safe ? node.setAttribute(attribute.name, safe) : node.removeAttribute(attribute.name);
      }
      if (name === "style") node.setAttribute("style", sanitizeCss(attribute.value));
    }
  });
  const styles = [...parsed.querySelectorAll("style")].map((node) => node.textContent || "").join("\n");
  parsed.querySelectorAll("style").forEach((node) => node.remove());
  return {
    title: parsed.title.trim() || currentFileName.replace(/\.html?$/iu, ""),
    html: parsed.body.innerHTML,
    css: sanitizeCss(styles),
    removedScriptCount,
    renderedChartCount: Object.keys(renderedCharts).length
  };
}

function pageCss() {
  const size = `${elements.pageSize.value} ${orientation}`;
  const margin = Number(elements.margin.value);
  return `
    @page { size: ${size}; margin: ${margin}mm; }
    html, body { print-color-adjust: ${elements.keepBackground.checked ? "exact" : "economy"}; -webkit-print-color-adjust: ${elements.keepBackground.checked ? "exact" : "economy"}; }
    img, svg, table, figure { max-width: 100%; }
    img { height: auto; }
    thead { display: table-header-group; }
    tr, img, figure { break-inside: avoid; }
  `;
}

async function renderPreview() {
  const sequence = ++renderSequence;
  setStatus("正在生成分页预览…");
  elements.exportButton.disabled = true;
  try {
    const chartResult = await renderEchartsInWorker(elements.source.value);
    if (sequence !== renderSequence) return;
    const content = parseAndSanitize(elements.source.value, chartResult.charts);
    elements.preview.replaceChildren();
    if (stylesheetUrl) URL.revokeObjectURL(stylesheetUrl);
    stylesheetUrl = URL.createObjectURL(new Blob([`${pageCss()}\n${content.css}`], { type: "text/css" }));
    const previewer = new window.PagedModule.Previewer();
    const flow = await previewer.preview(content.html, [stylesheetUrl], elements.preview);
    if (sequence !== renderSequence) return;
    const pages = flow.total || elements.preview.querySelectorAll(".pagedjs_page").length;
    elements.pageCount.textContent = `${pages} 页`;
    elements.documentMeta.textContent = `${currentFileName} · ${pages} 页`;
    elements.exportButton.disabled = pages === 0;
    setStatus(content.renderedChartCount > 0 ? `分页预览已就绪 · 已固化 ${content.renderedChartCount} 个 ECharts 图表` : "分页预览已就绪", "success");
  } catch (error) {
    if (sequence !== renderSequence) return;
    elements.pageCount.textContent = "0 页";
    setStatus(error instanceof Error ? error.message : String(error), "error");
  }
}

function scheduleRender() {
  window.clearTimeout(renderTimer);
  renderTimer = window.setTimeout(renderPreview, 450);
}

elements.source.addEventListener("input", scheduleRender);
elements.importButton.addEventListener("click", () => elements.fileInput.click());
elements.fileInput.addEventListener("change", async () => {
  const file = elements.fileInput.files?.[0];
  if (!file) return;
  currentFileName = file.name;
  elements.source.value = await file.text();
  await renderPreview();
  elements.fileInput.value = "";
});
elements.resetButton.addEventListener("click", async () => {
  currentFileName = "示例周报.html";
  elements.source.value = sampleHtml;
  await renderPreview();
});
elements.pageSize.addEventListener("change", renderPreview);
elements.margin.addEventListener("input", () => {
  elements.marginValue.value = `${elements.margin.value} mm`;
  scheduleRender();
});
elements.keepBackground.addEventListener("change", renderPreview);
document.querySelectorAll("[data-orientation]").forEach((button) => {
  button.addEventListener("click", async () => {
    orientation = button.dataset.orientation;
    document.querySelectorAll("[data-orientation]").forEach((item) => item.classList.toggle("is-active", item === button));
    await renderPreview();
  });
});
elements.zoom.addEventListener("input", () => {
  elements.preview.style.setProperty("--preview-scale", String(Number(elements.zoom.value) / 100));
  elements.zoomValue.value = `${elements.zoom.value}%`;
});
elements.exportButton.addEventListener("click", async () => {
  if (!window.desktopWebapp?.exportPdf) {
    setStatus("请从 Desktop 侧边栏打开后导出 PDF。", "error");
    return;
  }
  elements.exportButton.disabled = true;
  setStatus("正在准备 PDF…");
  const result = await window.desktopWebapp.exportPdf({
    defaultFileName: currentFileName.replace(/\.html?$/iu, "")
  });
  elements.exportButton.disabled = false;
  setStatus(result.message, result.ok ? "success" : result.cancelled ? "" : "error");
});

elements.source.value = sampleHtml;
elements.preview.style.setProperty("--preview-scale", ".75");
void renderPreview();
