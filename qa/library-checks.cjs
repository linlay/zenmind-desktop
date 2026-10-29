const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const output = process.env.LIBRARY_QA_DIR;
app.setPath('userData', path.join(output, 'profile'));
app.setPath('sessionData', path.join(output, 'session'));
const errors = [];
const server = http.createServer((req, res) => {
  const name = path.basename(new URL(req.url, 'http://localhost').pathname) || 'index.html', file = path.join(output, name);
  res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
  if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; } res.end(fs.readFileSync(file));
});
let win;
const js = async code => { try { return await win.webContents.executeJavaScript(code); } catch (error) { console.error('Evaluation failed:', code); throw error; } };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(code) { for (let i = 0; i < 200; i++) { if (await js(code)) return; await delay(25); } throw Error('Timed out: ' + code); }
const frame = () => js('new Promise(resolve=>requestAnimationFrame(resolve))');
const click = async selector => { await js('document.querySelector(' + JSON.stringify(selector) + ').click()'); await frame(); };
const clickText = async (selector, text) => { await js('[...document.querySelectorAll(' + JSON.stringify(selector) + ')].find(element=>element.textContent.trim()===' + JSON.stringify(text) + ').click()'); await frame(); };
const input = (selector, value) => js('(()=>{const element=document.querySelector(' + JSON.stringify(selector) + ');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(element,' + JSON.stringify(value) + ');element.dispatchEvent(new Event("input",{bubbles:true}));})()');
const submit = () => click('.library-dialog button[type=submit]');
const modalClosed = () => until('!document.querySelector(".ant-modal-wrap")||getComputedStyle(document.querySelector(".ant-modal-wrap")).display==="none"');
const all = async () => { await clickText('.library-nav-row span:not(.anticon)', '全部资料'); await until('document.querySelector("h1").textContent==="全部资料"&&document.querySelectorAll(".library-file").length===9'); };
const menuItem = text => clickText('.library-menu-item', text);
async function shot(name) { await delay(120); fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
(async () => {
  await app.whenReady(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  win = new BrowserWindow({ show: false, width: 1280, height: 820, useContentSize: true, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  await win.loadURL('http://127.0.0.1:' + server.address().port);
  await until('document.querySelectorAll(".library-file").length===9');
  assert.equal(await js('document.querySelector(".library-topbar").getBoundingClientRect().height'), 44);
  assert.equal(await js('getComputedStyle(document.querySelector(".library-inspector")).display'), 'none');
  assert.equal(await js('document.querySelectorAll(".library-topbar .library-head-actions").length'), 0);
  assert.equal(await js('document.querySelector("h1").getBoundingClientRect().height'), 1);
  await shot('no-selection');
  assert.deepEqual(await js('[...document.querySelectorAll(".library-layout-switcher button")].map(button=>button.title)'), ['小卡片', '大卡片', '列表']);
  assert.equal(await js('document.querySelector(".library-page").textContent.toLowerCase().includes("theme")'), false);
  await click('.library-file[aria-label="Landscape.png"]');
  await until('document.querySelector(".library-inspector img")?.naturalWidth>0');
  await shot('light-large');
  await click('[aria-label="小卡片"]'); await until('document.querySelector(".layout-small")'); await shot('light-small');
  await click('[aria-label="列表"]'); await until('document.querySelector(".layout-list")'); await shot('light-list');
  await js('window.qa.remount()'); await until('document.querySelectorAll(".layout-list .library-file").length===9');
  assert.equal(await js('localStorage.getItem("desktop.library.layout")'), 'list');
  await click('[aria-label="大卡片"]');
  await require('./library-selection-checks.cjs')({ win, js, until, delay, click, shot });
  // Folder hierarchy, direct contents and breadcrumb navigation.
  await click('.library-tree-chevron[aria-label="展开Research"]'); await click('.library-tree-chevron[aria-label="展开Brand"]');
  await clickText('.library-tree-label > span:not(.anticon)', 'Images');
  await until('document.querySelector("h1").textContent==="Images"&&document.querySelectorAll(".library-file").length===1');
  assert.equal(await js('document.querySelector(".library-breadcrumbs").textContent.includes("ResearchBrandImages")'), true);
  await shot('nested-folder');
  await all();
  // Single item alias, tags, favorite, source and exact Run identity.
  await click('.library-file[aria-label="Annual report.docx"] .library-file-more'); await menuItem('重命名');
  await until('document.querySelector(".library-dialog .ant-modal-content")');
  assert.deepEqual(await js('(()=>{const panel=document.querySelector(".library-dialog .ant-modal-content"),style=getComputedStyle(panel);return {shared:panel.classList.contains("sidebar-operation-menu-popover"),radius:style.borderRadius,background:style.backgroundColor,blur:style.backdropFilter};})()'), { shared: true, radius: '16px', background: 'rgba(255, 255, 255, 0.9)', blur: 'blur(18px) saturate(1.35)' });
  await delay(250); await shot('dialog-light');
  await until('document.querySelector(".library-dialog-field input")'); await input('.library-dialog-field input', 'Approved report'); await submit(); await modalClosed();
  await until('[...document.querySelectorAll(".library-file")].some(item=>item.getAttribute("aria-label")==="Approved report")');
  assert.equal(await js('window.qa.data[0].name'), 'Annual report.docx');
  await click('.library-file[aria-label="Approved report"]'); await click('.library-add-tag'); await input('.library-add-tag-form input', 'Approved');
  await click('.library-add-tag-form button[type=submit]'); await until('document.querySelector(".library-detail-tags").textContent.includes("Approved")');
  await click('.library-detail-actions button[aria-label="收藏资料"]'); await until('window.qa.data[0].favorite===true');
  await click('.library-detail-actions .is-primary'); await until('window.qa.views.length===1');
  assert.equal(await js('window.qa.actions.at(-1).runId'), 'run-0');
  assert.equal(await js('window.qa.views.at(-1).relativePath'), 'artifacts/run-0/Annual report.docx');
  await click('.library-source button'); await until('window.qa.chats.length===1');
  // Nav bar menu shell, row metrics, bounded placement, keyboard dismissal.
  await click('.library-file[aria-label="Landscape.png"] .library-file-more'); await until('document.querySelector(".library-menu")');
  assert.deepEqual(await js('(()=>{const menu=document.querySelector(".library-menu"),row=menu.querySelector("button"),rect=menu.getBoundingClientRect();return {shared:menu.classList.contains("sidebar-operation-menu-popover"),radius:getComputedStyle(menu).borderRadius,font:getComputedStyle(row).fontSize,row:row.getBoundingClientRect().height,bounded:rect.left>=8&&rect.right<=innerWidth-8&&rect.top>=8&&rect.bottom<=innerHeight-8}})()'), { shared: true, radius: '16px', font: '14px', row: 28, bounded: true });
  await shot('menu-light'); await js('document.querySelector(".library-menu").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  await until('!document.querySelector(".library-menu")');
  // Source restrictions keep view and download disabled.
  for (const name of ['Archive report.pdf', 'Legacy.txt', 'Conflicting.txt']) {
    await click('.library-file[aria-label="' + name + '"] .library-file-more');
    assert.equal(await js('[...document.querySelectorAll(".library-menu-item")].find(element=>element.textContent.trim()==="打开资料").disabled'), true);
    assert.equal(await js('[...document.querySelectorAll(".library-menu-item")].find(element=>element.textContent.trim()==="下载").disabled'), true);
    await js('document.querySelector(".library-menu").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  }
  // Create a real nested folder; duplicate errors stay in the dialog.
  await click('.library-side-label button'); await until('document.querySelector(".library-dialog-field input")'); await input('.library-dialog-field input', 'Data'); await submit(); await modalClosed();
  await click('.library-side-label button'); await until('document.querySelector(".library-dialog-field input")'); await input('.library-dialog-field input', 'Data'); await submit();
  await until('document.querySelector(".library-dialog-error")?.textContent.includes("同名")'); await click('.ant-modal-close'); await modalClosed();
  await clickText('.library-tree-label > span:not(.anticon)', 'Data'); await until('document.querySelector("h1").textContent==="Data"');
  await click('.library-tree-row.is-active .library-tree-more'); await menuItem('新建子资料夹'); await until('document.querySelector(".library-dialog-field input")'); await input('.library-dialog-field input', 'Reports'); await submit(); await modalClosed();
  assert.equal(await js('window.qa.folders.find(folder=>folder.name==="Reports").parentId===window.qa.folders.find(folder=>folder.name==="Data").id'), true);
  await all();
  // Two-item move dialog applies exactly the selection.
  await click('.library-file[aria-label="Approved report"] .library-file-check'); await click('.library-file[aria-label="Dashboard.html"] .library-file-check');
  await until('document.querySelector(".library-selectionbar")'); await click('.library-selectionbar .library-button');
  await until('document.querySelector(".library-move-targets")'); await clickText('.library-move-target', 'Reports'); await submit(); await modalClosed();
  assert.equal(await js('window.qa.moves.at(-1).items.length'), 2);
  assert.equal(await js('window.qa.data[0].folderId===window.qa.folders.find(folder=>folder.name==="Reports").id'), true);
  await click('.library-selectionbar [aria-label="取消选择"]');
  // Internal drag payload on a folder card is handled by the actual drop code.
  await js('(()=>{const transfer=new DataTransfer();transfer.setData("application/x-zenmind-library-items",JSON.stringify([{chatId:"chat-5",runId:"run-5",artifactId:"artifact-5"}]));[...document.querySelectorAll(".library-folder-card")].find(element=>element.textContent.includes("Delivery")).dispatchEvent(new DragEvent("drop",{bubbles:true,dataTransfer:transfer}));})()');
  await until('window.qa.data[5].folderId==="delivery"');
  await clickText('.library-nav-row span:not(.anticon)', '待整理'); await until('window.qa.queries.at(-1).folderId===null');
  assert.equal(await js('document.querySelectorAll(".library-file").length'), 3);
  await all();
  await clickText('.library-filters button', '图片1'); await until('document.querySelectorAll(".library-file").length===1');
  assert.equal(await js('window.qa.queries.at(-1).category'), 'image');
  await clickText('.library-nav-row span:not(.anticon)', '我的收藏'); await until('document.querySelectorAll(".library-file").length===2');
  await all();
  await input('.library-search input', 'Approved report'); await until('document.querySelectorAll(".library-file").length===1');
  await input('.library-search input', ''); await until('document.querySelectorAll(".library-file").length===9');
  await click('.library-sidebar-sync button'); await until('window.qa.syncs===1'); await until('document.querySelector(".library-sync-summary").textContent.includes("同步完成")');
  await click('.library-file[aria-label="Landscape.png"]');
  await js('window.qa.setLocale("en-US");window.qa.setDark(true)'); await until('document.querySelector("h1").textContent==="All items"');
  await shot('dark');
  await click('.library-brand .library-icon-button'); await menuItem('About the library');
  await until('document.querySelector(".library-dialog .ant-modal-content")'); await delay(250); await shot('dialog-dark');
  assert.equal(await js('getComputedStyle(document.querySelector(".library-dialog .ant-modal-content")).backgroundColor'), 'rgba(31, 35, 42, 0.9)');
  await click('.ant-modal-close'); await modalClosed();
  await click('.library-file[aria-label="Landscape.png"] .library-file-more'); await shot('menu-dark');
  await js('document.querySelector(".library-menu").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  // Narrow navigation and inspector overlays must fit the actual container.
  win.setContentSize(680, 700); await delay(150);
  assert.equal(await js('getComputedStyle(document.querySelector(".library-sidebar")).display'), 'none');
  await click('.library-navigation-toggle'); await until('getComputedStyle(document.querySelector(".library-sidebar")).display==="flex"');
  await click('.library-sidebar-mask');
  await click('.library-topbar > button:last-child'); await until('getComputedStyle(document.querySelector(".library-inspector")).display==="flex"');
  assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true); await shot('narrow-details');
  await click('.library-inspector-head button'); await shot('narrow');
  await js('window.qa.platform="win32";window.qa.remount()'); await until('document.querySelectorAll(".library-file").length===9');
  await click('.library-file[aria-label="Landscape.png"] .library-file-more'); await until('document.querySelector(".library-menu")');
  assert.equal(await js('document.querySelector(".library-menu").textContent.includes("Show in File Explorer")'), true);
  await js('document.querySelector(".library-menu").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  // Pagination, live events and retry use the production request path.
  win.setContentSize(1280, 820); await js('window.qa.pushMany()'); await until('document.querySelectorAll(".library-file").length===50');
  await require('./library-selection-checks.cjs').scroll({ win, js, until, delay });
  await click('.library-pagination button:last-child'); await until('document.querySelectorAll(".library-file").length===14');
  await js('window.qa.fail=true;window.qa.notify()'); await until('document.querySelector(".library-empty[role=alert]")');
  await js('window.qa.fail=false'); await click('.library-empty button'); await until('document.querySelectorAll(".library-file").length===14');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, 'passed'), 'ok');
  console.log(JSON.stringify({ ok: true, checks: ['real component in StrictMode', 'thin header and three remembered layouts', 'mouse marquee in three layouts', 'Shift range and Command/Ctrl selection', 'marquee auto-scroll and Escape cancellation', 'file drag preserves selection', 'nested tree and breadcrumbs', 'aliases preserve source filenames', 'tags, favorites and source actions', 'shared menu styling and keyboard', 'source restrictions', 'nested folder creation and duplicate validation', 'bulk moves and internal drops', 'unfiled, category and search filters', 'sync and source Run identity', 'Chinese/English and light/dark', 'narrow navigation and inspector', 'Windows file manager label', 'pagination, live updates and retry'], output }, null, 2));
  win.destroy(); server.close(); app.quit();
})().catch(async error => {
  console.error(error); console.error('QA output:', output); console.error('Renderer errors:', errors);
  if (win) { try { await shot('failure'); console.error(await js('document.body.innerText')); } catch {} win.destroy(); }
  server.close(); app.exit(1);
});
