/* Real Chromium integration harness. All generated files and sessions live in
 * the runner's disposable directory; optional dashboards are read-only inputs. */
const { app, BrowserWindow, protocol, session, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { pathToFileURL } = require("node:url");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const project = path.resolve(__dirname, "../..");
const { WorkPanelDocumentHtmlRegistry } = require(path.join(project, "dist-electron/main/modules/work-panel/document-html.js"));
const { registerChatWorkPanelLocalFileProtocolScheme } = require(path.join(project, "dist-electron/main/modules/work-panel/local-files.js"));
const { prepareWebviewAttachPreferences } = require(path.join(project, "dist-electron/main/modules/shell/window-manager.js"));
const { WORK_PANEL_DOCUMENT_HTML_REVIEW_CHANNEL } = require(path.join(project, "dist-electron/shared/work-panel-document-html.js"));
const root = process.env.HTML_TEST_ROOT;
const previewPreload = process.env.HTML_REVIEW_PRELOAD_PATH;
const progress = (message) => fs.appendFileSync(path.join(root, "progress.log"), `${message}\n`);
const hostHtml = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; frame-src 'self'"><body></body>`;
app.setPath("userData", path.join(root, "profile"));
app.setPath("sessionData", path.join(root, "session"));
registerChatWorkPanelLocalFileProtocolScheme(protocol);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await check()) return; await pause(50); }
  throw Error(`Timed out: ${label}`);
}
let window;
let server;
const registry = new WorkPanelDocumentHtmlRegistry();
let guest;
let number = 0;
const guests = [];

async function openDocument(filePath) {
  progress(`open ${path.basename(filePath)}`);
  if (guest && !guest.isDestroyed()) {
    await window.webContents.executeJavaScript("document.querySelector('#preview-host')?.remove()");
    guest = null;
  }
  const claim = await registry.prepareClaim({ ownerChatId: "test-chat", rendererWebContentsId: window.webContents.id,
    source: { kind: "workspace-file", agentKey: "test-agent", path: path.basename(filePath) }, workspaceFilePath: filePath });
  assert.equal(claim.ok, true);
  const result = await registry.claim({ claimId: claim.claimId, ownerChatId: "test-chat", rendererGeneration: "test-generation" }, window.webContents);
  const request = { ownerChatId: "test-chat", rendererGeneration: "test-generation", handleId: result.document.handleId };
  const preview = await registry.preview(request, window.webContents);
  progress(`preview ${JSON.stringify(preview)}`);
  assert.equal(preview.ok, true);
  const attached = once(window.webContents, "did-attach-webview");
  await window.webContents.executeJavaScript(`(() => {
    const view = document.createElement('webview');
    view.setAttribute('partition', ${JSON.stringify(preview.partition)});
    view.setAttribute('preload', ${JSON.stringify(pathToFileURL(previewPreload).href)});
    view.setAttribute('src', ${JSON.stringify(preview.url)});
    const host = document.createElement('div');
    host.id = 'preview-host';
    host.className = 'work-panel-document-html-body';
    host.style.cssText = 'position:relative;width:1200px;height:900px';
    window.reviewEvents = [];
    view.addEventListener('ipc-message', event => window.reviewEvents.push(event.args[0]));
    host.appendChild(view);
    document.body.appendChild(host);
  })()`);
  const [, contents] = await Promise.race([attached, pause(15000).then(() => { throw Error("WebView did not attach"); })]);
  progress("attached");
  guest = contents;
  guest.on("console-message", (_event, level, message) => {
    if (level >= 2 && !/Electron Security Warning|Content Security Policy|insecure Content-Security-Policy/i.test(message)) console.log("guest diagnostic:", String(message).slice(0, 220));
  });
  await until(async () => {
    try { return (await guest.executeJavaScript("document.readyState")) === "complete"; } catch { return false; }
  }, "document loaded");
  return { request, preview };
}

async function run() {
  await app.whenReady();
  progress("app-ready");
  const receivedCookies = [];
  server = http.createServer((req, res) => {
    if (req.url === "/host") { res.setHeader("Content-Type", "text/html"); res.end(hostHtml); return; }
    if (req.url === "/react-host.js") { res.setHeader("Content-Type", "text/javascript"); res.end(fs.readFileSync(path.join(root, "react-host.js"))); return; }
    if (req.url !== "/no-cors") res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.url === "/script.js") { res.setHeader("Content-Type", "text/javascript"); res.end("window.externalWorks = true;"); }
    else if (req.url === "/external.css") { res.setHeader("Content-Type", "text/css"); res.end("h1{color:rgb(12,34,56)}"); }
    else { receivedCookies.push(req.headers.cookie || ""); res.setHeader("Content-Type", "application/json"); res.end('{"ok":true}'); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const external = `http://127.0.0.1:${server.address().port}`;
  await session.defaultSession.cookies.set({ url: external, name: "desktop_session_secret", value: "must-not-be-shared" });
  window = new BrowserWindow({ show: false, width: 1280, height: 960,
    webPreferences: { webviewTag: true, nodeIntegration: false, contextIsolation: true, sandbox: false,
      preload: path.join(__dirname, "document-html-host-preload.cjs") } });
  window.webContents.on("console-message", (_event, level, message) => progress(`host console ${level}: ${String(message).slice(0, 300)}`));
  registry.configure({ app, getMainWindow: () => window });
  ipcMain.handle("test:html-preview", (event, request) => registry.preview(request, event.sender));
  window.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    const allowed = prepareWebviewAttachPreferences({ webPreferences, params,
      servicePreloadPath: path.join(path.dirname(previewPreload), "service-webview.js"), servicePreloadUrl: pathToFileURL(path.join(path.dirname(previewPreload), "service-webview.js")).href,
      isSafeServiceUrl: () => false,
      isDocumentHtmlPreview: (url, partition) => registry.previews.canAttach(url, partition, window.webContents.id),
    });
    progress(`will-attach ${JSON.stringify(allowed)}`);
    if (!allowed.ok) { event.preventDefault(); throw Error(`Invalid test preview: ${JSON.stringify(allowed)}`); }
  });
  window.webContents.on("did-attach-webview", (_event, contents) => {
    progress("did-attach");
    number += 1;
    guests.push(contents);
    assert.equal(registry.previews.configureGuest(contents, window.webContents.id), true);
  });
  await window.loadURL(`${external}/host`);
  const productionCss = fs.readFileSync(path.join(project, "src/renderer/styles/app-shell.css"), "utf8")
    .match(/\.work-panel-document-html-body\s*>\s*webview\s*\{[^}]*\}/u)?.[0];
  assert.ok(productionCss, "use the actual production viewport rule, not a test-only sizing workaround");
  await window.webContents.executeJavaScript(`(() => { const style=document.createElement('style'); style.textContent=${JSON.stringify(productionCss)}; document.head.appendChild(style); })()`);
  // This reproduces the old srcDoc bug under the real shell policy.
  await window.webContents.executeJavaScript(`new Promise(resolve => {
    const frame = document.createElement('iframe'); frame.srcdoc = '<script>window.inlineWorks=true<\\/script>';
    frame.onload = () => { window.oldResult = frame.contentWindow.inlineWorks; frame.remove(); resolve(); };
    document.body.appendChild(frame);
  })`);
  assert.equal(await window.webContents.executeJavaScript("window.oldResult"), undefined);
  progress("baseline CSP confirmed");
  const fixturePath = path.join(root, "index.html");
  fs.mkdirSync(path.join(root, "assets"));
  fs.writeFileSync(path.join(root, "assets/pixel.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>');
  fs.writeFileSync(path.join(root, "assets/style.css"), "@import './nested.css'; #box{background-image:url('./pixel.svg');width:40px;height:40px}");
  fs.writeFileSync(path.join(root, "assets/nested.css"), "#box{border:3px solid green}");
  fs.writeFileSync(path.join(root, "assets/module.mjs"), "export default 42;");
  fs.writeFileSync(path.join(root, "assets/data.json"), '{"value":42}');
  fs.writeFileSync(fixturePath, `<!doctype html><link rel="stylesheet" href="${external}/external.css"><link rel="stylesheet" href="assets/style.css">
    <script src="${external}/script.js"></script><h1 id="title">Preview fixture</h1><div id="box"></div><img src="assets/pixel.svg">
    <script>window.inlineWorks=true; window.finished=false;
    Promise.all([fetch('assets/data.json').then(r=>r.json()), fetch('${external}/data').then(r=>r.json()), import('./assets/module.mjs'), fetch('${external}/no-cors').then(()=>false,()=>true)])
    .then(([local,external,module,corsBlocked])=>{window.results={local:local.value,external:external.ok,module:module.default,corsBlocked};window.finished=true});</script>`);
  const opened = await openDocument(fixturePath);
  await until(() => guest.executeJavaScript("window.finished"), "external resources, local fetch and module");
  assert.deepEqual(await guest.executeJavaScript("window.results"), { local: 42, external: true, module: 42, corsBlocked: true });
  assert.deepEqual(await guest.executeJavaScript("[window.inlineWorks,window.externalWorks,typeof require,typeof window.electronAPI,getComputedStyle(document.querySelector('h1')).color,getComputedStyle(document.querySelector('#box')).borderTopWidth,document.querySelector('img').naturalWidth]"),
    [true, true, "undefined", "undefined", "rgb(12, 34, 56)", "3px", 2]);
  assert.equal(receivedCookies.some((cookie) => cookie.includes("desktop_session_secret")), false);
  const prefs = guest.getLastWebPreferences();
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.webSecurity, true);
  const activeGuestId = guest.id;
  await window.webContents.executeJavaScript("document.querySelector('#preview-host').style.display='none'");
  await window.webContents.executeJavaScript("document.querySelector('#preview-host').style.cssText='position:relative;width:900px;height:700px'");
  guest.send(WORK_PANEL_DOCUMENT_HTML_REVIEW_CHANNEL, { type: "resize" });
  assert.equal(guest.id, activeGuestId);
  await until(() => guest.executeJavaScript("innerHeight === 700 && innerWidth === 900"), "guest viewport fills resized host");
  // Page scripts cannot turn on annotation mode through the old message bridge.
  await guest.executeJavaScript("window.postMessage({type:'zenmind-html-annotation-mode',enabled:true},'*')");
  assert.notEqual(await guest.executeJavaScript("document.documentElement.style.cursor"), "crosshair");
  await window.webContents.executeJavaScript(`document.querySelector('webview').send(${JSON.stringify(WORK_PANEL_DOCUMENT_HTML_REVIEW_CHANNEL)}, { type: 'zenmind-html-annotation-mode', enabled: true })`);
  await until(() => guest.executeJavaScript("document.documentElement.style.cursor==='crosshair'"), "isolated annotation mode");
  guest.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, x: 60, y: 30 });
  guest.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, x: 60, y: 30 });
  await until(() => window.webContents.executeJavaScript("window.reviewEvents.some(e=>e?.type==='zenmind-html-annotation')"), "annotation handoff");
  guest.send(WORK_PANEL_DOCUMENT_HTML_REVIEW_CHANNEL, { type: "zenmind-html-annotation-locate", items: [{ id: "valid", selector: "#title" }, { id: "missing", selector: "#gone" }] });
  await until(() => window.webContents.executeJavaScript("window.reviewEvents.some(e=>e?.type==='zenmind-html-annotation-located'&&e.items[0].valid&&!e.items[1].valid)"), "annotation relocation");
  await guest.executeJavaScript(`window.open('${external}/popup'); location.href='${external}/navigate'`);
  await pause(200);
  assert.equal(number, 1);
  assert.equal(guest.getURL(), opened.preview.url);
  const reloaded = once(guest, "did-finish-load");
  await registry.preview(opened.request, window.webContents);
  guest.reload();
  await reloaded;
  await until(() => guest.executeJavaScript("window.finished"), "reload");
  assert.equal(guest.id, activeGuestId);
  console.log("PASS: inherited-CSP regression, external script/CSS/API, relative CSS/image/module/JSON, CORS, session isolation, annotation, resize/hide/reload, popup/navigation denial");

  for (const file of JSON.parse(process.env.HTML_DASHBOARD_FILES || "[]")) {
    const before = fs.readFileSync(file);
    await openDocument(file);
    await until(() => guest.executeJavaScript("typeof echarts==='object' && document.querySelectorAll('[_echarts_instance_]').length===9"), "all nine ECharts");
    const charts = await guest.executeJavaScript("Array.from(document.querySelectorAll('[_echarts_instance_]'),el=>{const c=echarts.getInstanceByDom(el);return {width:c.getWidth(),height:c.getHeight(),series:c.getOption().series.length}})");
    assert.equal(charts.length, 9);
    assert.ok(charts.every((chart) => chart.width > 0 && chart.height > 0 && chart.series > 0));
    await until(() => guest.executeJavaScript("Array.from(document.querySelectorAll('[_echarts_instance_]')).every(el=>echarts.getInstanceByDom(el).getZr().animation.isFinished())"), "all chart animations finished");
    if (process.env.HTML_KEEP_TEST_OUTPUT === "1") fs.writeFileSync(path.join(root, `dashboard-${number}.png`), (await guest.capturePage()).toPNG());
    assert.deepEqual(fs.readFileSync(file), before, "original dashboard must not be modified");
    console.log(`PASS: ${path.basename(file)} — 9 rendered ECharts`, JSON.stringify(charts));
  }
  if (process.env.HTML_CDN_SMOKE === "1") {
    const cdnFile = path.join(root, "cdn.html");
    fs.writeFileSync(cdnFile, '<!doctype html><script src="https://cdn.jsdelivr.net/npm/echarts@5.4.3/dist/echarts.min.js"></script><div id="chart" style="width:600px;height:400px"></div><script>echarts.init(document.getElementById("chart")).setOption({xAxis:{data:["a","b"]},yAxis:{},series:[{type:"bar",data:[1,2]}]})</script>');
    await openDocument(cdnFile);
    assert.equal(await guest.executeJavaScript("typeof echarts==='object' && !!document.querySelector('canvas')"), true);
    console.log("PASS: live HTTPS ECharts CDN smoke");
  }
  await window.webContents.executeJavaScript("document.querySelector('#preview-host')?.remove()");
  const claim = await registry.prepareClaim({ ownerChatId: "test-chat", rendererWebContentsId: window.webContents.id,
    source: { kind: "workspace-file", agentKey: "test-agent", path: path.basename(fixturePath) }, workspaceFilePath: fixturePath });
  const claimed = await registry.claim({ claimId: claim.claimId, ownerChatId: "test-chat", rendererGeneration: "test-generation" }, window.webContents);
  const componentCss = fs.readFileSync(path.join(project, "src/renderer/styles/app-shell.css"), "utf8");
  await window.webContents.executeJavaScript(`new Promise(resolve => { const style = document.createElement('style'); style.textContent = ${JSON.stringify(componentCss)}; document.head.appendChild(style); const script = document.createElement('script'); script.src='/react-host.js'; script.onload=resolve; document.head.appendChild(script); })`);
  const attached = once(window.webContents, "did-attach-webview");
  await window.webContents.executeJavaScript(`window.mountHtmlReview(${JSON.stringify(claimed.document)}, ${JSON.stringify(pathToFileURL(previewPreload).href)})`);
  [, guest] = await attached;
  await until(() => window.webContents.executeJavaScript("!!document.querySelector('.work-panel-document-html-toolbar button[title]:not(:disabled) .anticon-edit')"), "React toolbar ready");
  await window.webContents.executeJavaScript("document.querySelector('.anticon-edit').closest('button').click()");
  await until(() => guest.executeJavaScript("document.documentElement.style.cursor==='crosshair'"), "React edit button enables guest selection");
  guest.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, x: 60, y: 30 });
  guest.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, x: 60, y: 30 });
  await until(() => window.webContents.executeJavaScript("!!document.querySelector('.work-panel-document-html-annotation-dialog textarea')"), "React selection dialog");
  await window.webContents.executeJavaScript(`(() => {
    const textarea = document.querySelector('.work-panel-document-html-annotation-dialog textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, 'Test annotation requirement');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await until(() => window.webContents.executeJavaScript("!!document.querySelector('.ant-modal .ant-btn-primary:not(:disabled)')"), "annotation requirement accepted");
  await window.webContents.executeJavaScript("document.querySelector('.ant-modal .ant-btn-primary').click()");
  await until(() => window.webContents.executeJavaScript("document.querySelector('.work-panel-document-html-count').textContent.includes('1')"), "React annotation count");
  await until(() => guest.executeJavaScript("document.querySelector('#__zenmind_native_html_review_overlay__')?.textContent==='1'"), "numbered guest marker");
  const reviewedGuestId = guest.id;
  await window.webContents.executeJavaScript("document.querySelector('.work-panel-document-html-toolbar .anticon-reload').closest('button').click()");
  await until(() => window.webContents.executeJavaScript("!!document.querySelector('.ant-modal-confirm-btns .ant-btn-primary')"), "refresh protects annotations");
  const reviewedReload = once(guest, "did-finish-load");
  await window.webContents.executeJavaScript("document.querySelector('.ant-modal-confirm-btns .ant-btn-primary').click()");
  await reviewedReload;
  await until(() => guest.executeJavaScript("document.querySelector('#__zenmind_native_html_review_overlay__')?.textContent==='1' && document.documentElement.style.cursor==='crosshair'"), "annotation restored after refresh");
  assert.equal(guest.id, reviewedGuestId);
  await window.webContents.executeJavaScript("document.querySelector('.work-panel-document-html-count').click()");
  await until(() => window.webContents.executeJavaScript("!!document.querySelector('.work-panel-document-html-annotation-actions button:not(:disabled)')"), "annotation handoff enabled");
  await window.webContents.executeJavaScript("document.querySelector('.work-panel-document-html-annotation-actions button').click()");
  await until(() => window.webContents.executeJavaScript("window.testHandoff?.length===1 && !document.querySelector('.work-panel-document-html.is-annotating')"), "React handoff completes");
  assert.equal((await window.webContents.executeJavaScript("window.testHandoff"))[0].note, "Test annotation requirement");
  console.log("PASS: production React edit -> element selection -> requirement -> numbered marker -> protected refresh -> handoff");
}

async function shutdown() {
  registry.dispose();
  // Let detached guests finish destruction before tearing down their embedder.
  // Immediate app.exit() can race Chromium's asynchronous WebView teardown.
  await until(() => guests.every((contents) => contents.isDestroyed()), "guest disposal");
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  window?.destroy();
}

run().then(async () => {
  await shutdown();
  fs.writeFileSync(path.join(root, "passed.json"), JSON.stringify({ ok: true, documents: number }));
  app.quit();
}).catch(async (error) => {
  fs.writeFileSync(path.join(root, "failed.txt"), error.stack || String(error));
  console.error(error);
  try { await shutdown(); } finally { app.exit(1); }
});
