const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = process.env.WEB_SETTINGS_PREVIEW_ROOT;
if (!root) throw new Error("Missing isolated preview root");
app.setPath("userData", path.join(root, "profile"));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1280, height: 860, webPreferences: { contextIsolation: true, backgroundThrottling: false } });
  // Retain the native window throughout asynchronous captures.
  globalThis.webSettingsPreviewWindow = win;
  win.webContents.on('render-process-gone', (_event, details) => { console.error('Preview renderer exited:', details.reason); app.exit(1); });
  const errors = [];
  win.webContents.on("console-message", event => {
    if (/Uncaught|TypeError|ReferenceError/u.test(event.message)) { errors.push(event.message); console.error(event.message); }
  });
  const js = code => win.webContents.executeJavaScript(code);
  const wait = async condition => {
    for (let index = 0; index < 100; index++) {
      if (await js(condition)) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error("Timeout: " + condition);
  };
  const capture = async name => {
    await new Promise(resolve => setTimeout(resolve, 200));
    fs.writeFileSync(path.join(root, name + ".png"), (await win.webContents.capturePage()).toPNG());
  };
  const select = async section => {
    await js(`window.webSettingsPreview.navigate('/settings/${section}')`);
    await wait(`document.querySelector('.settings-page').dataset.settingsSection === '${section}'`);
    if (["control", "websites", "websiteBridges", "webapps"].includes(section)) await wait("!!document.querySelector('.service-hero-title-line h2')");
    else await wait("!!document.querySelector('.settings-section-body > *')");
    // Allow async selection and component effects to settle before measurement.
    await new Promise(resolve => setTimeout(resolve, 250));
  };
  // Keep the measurement callback self-contained inside the renderer.
  const snapshot = () => js(`(${function () {
    const style = el => {
      if (!el) return null;
      const s = getComputedStyle(el);
      return { font:s.fontFamily,size:s.fontSize,weight:s.fontWeight,color:s.color,background:s.backgroundColor,radius:s.borderRadius,padding:s.padding,border:s.borderColor,height:el.getBoundingClientRect().height };
    };
    const get = selector => style(document.querySelector(selector));
    const rect = document.querySelector('.settings-page').getBoundingClientRect();
    const detailRect = document.querySelector('.management-detail-group, .web-detail-card').getBoundingClientRect();
    return { section:document.querySelector('.settings-page').dataset.settingsSection,
      title:get('.service-hero-title-line h2'), head:get('.control-center-service-head'), catalog:get('.service-catalog'),
      detailWrapper:get('.web-settings-detail:not(.management-detail-group)'),
      routeCode:get('.website-bridge-routes code'),
      detail:get('.management-detail-group, .web-detail-card'), search:get('.website-bridges-search .sidebar-settings-search'),
      searchInput:get('.website-bridges-search input'), desktopSearch:get('.app-sidebar .sidebar-settings-search'),desktopSearchInput:get('.app-sidebar input'),
      referenceAction:get('.service-action-button:not(:disabled)'),
      selection:get('.service-nav-card.is-active, .website-bridge-item.is-selected'),
      selectionTitle:get('.service-nav-card.is-active h3, .web-nav-card.is-active .service-nav-card-title, .website-bridge-item.is-selected strong'),
      actions:[...document.querySelectorAll('.web-icon-action')].map(style),
      visible:rect.width>0 && rect.height>0 && rect.top<innerHeight && rect.bottom>0,
      detailVisible:detailRect.width>0 && detailRect.height>100 && detailRect.top>=0 && detailRect.bottom<=innerHeight+1,
      overflow:document.documentElement.scrollWidth>innerWidth };
  }.toString()})()`);
  await win.loadFile(path.join(root, "index.html"));
  await wait("window.webSettingsPreview && document.querySelector('.service-hero-title-line h2')");
  const report = [];
  for (const platform of ["mac", "windows"]) {
    await js(`window.webSettingsPreview.setPlatform('${platform}')`);
    for (const skin of ["default", "mist"]) {
      await js(`window.webSettingsPreview.appearance.setSkinId('${skin}')`);
      await js(`window.webSettingsPreview.setPhoto(${skin === "mist"})`);
      for (const mode of ["light", "dark"]) {
        await js(`window.webSettingsPreview.appearance.setThemeMode('${mode}')`);
        await wait(`document.documentElement.dataset.theme === '${mode}'`);
        await select("control");
        const reference = await snapshot();
        for (const section of ["control", "websites", "websiteBridges", "webapps"]) {
          await select(section);
          const state = await snapshot();
          for (const field of ["font", "size", "weight", "color"]) assert.equal(state.title[field], reference.title[field], `${section} title ${field}`);
          assert.equal(state.head.padding, reference.head.padding, `${section} header padding`);
          for (const field of ["background", "radius", "border"]) {
            assert.equal(state.catalog[field], reference.catalog[field], `${section} catalog ${field}`);
            assert.equal(state.detail[field], reference.detail[field], `${section} detail ${field}`);
          }
          for (const field of ["background", "color", "radius"]) assert.equal(state.selection[field], reference.selection[field], `${section} selection ${field}`);
          for (const field of ["font", "size", "weight", "color"]) assert.equal(state.selectionTitle[field], reference.selectionTitle[field], `${section} catalog title ${field}`);
          for (const action of state.actions) {
            assert.equal(action.height, reference.referenceAction.height, `${section} action size`);
            assert.equal(action.radius, reference.referenceAction.radius, `${section} action radius`);
            assert.equal(action.background, reference.referenceAction.background, `${section} action background`);
          }
          if (state.search) {
            for (const field of ["background", "radius", "border", "height"]) assert.equal(state.search[field], state.desktopSearch[field], `search ${field}`);
            for (const field of ["font", "size", "color"]) assert.equal(state.searchInput[field], state.desktopSearchInput[field], `search input ${field}`);
          }
          assert.equal(state.overflow, false, `${section} horizontal overflow`);
          assert.equal(state.visible, true, `${section} visible workspace`);
          assert.equal(state.detailVisible, true, `${section} visible detail`);
          if (state.detailWrapper) assert.equal(state.detailWrapper.background, 'rgba(0, 0, 0, 0)', `${section} transparent wrapper outside rounded panel`);
          if (state.routeCode) assert.equal(state.routeCode.background, 'rgba(0, 0, 0, 0)', `${section} route text without nested badges`);
          report.push({ platform, skin, mode, ...state });
          await capture(`${platform}-${skin}-${mode}-${section}`);
        }
      }
    }
  }
  await select("websites");
  const selectedBackground = (await snapshot()).selection.background;
  const selectedPoint = await js("(() => { const r = document.querySelector('.web-nav-card.is-active').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()");
  win.webContents.sendInputEvent({ type: 'mouseMove', ...selectedPoint });
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal((await snapshot()).selection.background, selectedBackground, 'selected item keeps control center selection on hover');
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 });
  await select("websiteBridges");
  await js(`(${function () {
    const input = document.querySelector('.website-bridges-search input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'not-found');
    input.dispatchEvent(new Event('input',{bubbles:true}));
  }.toString()})()`);
  await wait("document.querySelectorAll('.website-bridge-item').length === 0");
  await js("document.querySelector('.sidebar-settings-search-clear').click()");
  await wait("document.querySelectorAll('.website-bridge-item').length === 1");
  assert.equal(await js("document.activeElement === document.querySelector('.website-bridges-search input')"), true);
  // Hidden preview windows do not emit native focus events; simulate keyboard focus.
  await js("document.querySelector('.website-bridges-list .web-icon-action').focus(); document.querySelector('.website-bridges-list .web-icon-action').dispatchEvent(new FocusEvent('focusin', { bubbles: true }))");
  await wait("!!document.querySelector('.settings-action-tooltip:not(.ant-tooltip-hidden) .ant-tooltip-inner')");
  assert.equal(await js("getComputedStyle(document.querySelector('.settings-action-tooltip:not(.ant-tooltip-hidden)')).fontSize"), '11px');
  await js("document.querySelector('.website-bridges-list .web-icon-action').dispatchEvent(new FocusEvent('focusout', { bubbles: true })); document.querySelector('.website-bridges-search input').focus()");
  await js("document.querySelectorAll('.website-bridge-routes button')[1].click()");
  await wait("document.querySelector('.website-bridge-source').value.includes('pages/compose.js')");
  await js("document.querySelector('.website-bridge-heading .ant-switch').click()");
  await wait("window.webSettingsCalls.includes('bridge.enabled:false')");
  await js("document.querySelector('.website-bridge-heading button[aria-label=\"导入更新\"]').click()");
  await wait("window.webSettingsCalls.includes('bridge.import:sample-forum')");
  await js("document.querySelector('.website-bridges-list button[aria-label=\"导入 ZIP\"]').click()");
  await wait("window.webSettingsCalls.includes('bridge.import:new')");
  await js("document.querySelector('.website-bridge-heading button[aria-label=\"卸载\"]').click()");
  await wait("!!document.querySelector('.ant-modal')");
  assert.equal(await js("window.webSettingsCalls.includes('bridge.remove')"), false);
  await js("document.querySelector('.ant-modal-close').click()");
  await select("webapps");
  await js("document.querySelector('button[aria-label=\"停止\"]').click()");
  await wait("window.webSettingsCalls.includes('webapp.stop') && !document.querySelector('button[aria-label=\"启动\"]').disabled");
  await js("document.querySelector('button[aria-label=\"启动\"]').click()");
  await wait("window.webSettingsCalls.includes('webapp.start')");
  await js("document.querySelector('button[aria-label=\"查看应用详情\"]').click()");
  await wait("!!document.querySelector('.webapp-details-modal .ant-modal-content')");
  await js("document.querySelector('.ant-modal-close').click()");
  await js("window.webSettingsPreview.setEmpty(true)");
  await wait("!!document.querySelector('.webapp-import-empty')");
  assert.equal(await js("[...document.querySelectorAll('.settings-section-body button')].filter(b=>b.textContent.replace(/\\s/g,'')==='导入').length"), 1);
  assert.equal(await js("document.querySelectorAll('.webapp-import-empty button').length"), 0);
  await capture("webapp-empty");
  await js("window.webSettingsPreview.setEmpty(false)");
  await js("window.webSettingsPreview.setLocale('en-US')");
  // Desktop's native minimum is 1180px; narrow the workspace with its sidebar.
  win.setContentSize(1180, 860);
  await js("window.webSettingsPreview.setSidebarWidth(320)");
  for (const section of ["websites", "websiteBridges", "webapps"]) {
    await select(section);
    await wait("getComputedStyle(document.querySelector('.web-settings-shell')).gridTemplateColumns.split(' ').length === 1");
    const state = await snapshot();
    assert.equal(state.overflow, false, `${section} narrow overflow`);
    assert.equal(state.visible, true, `${section} narrow visible workspace`);
    assert.equal(state.detailVisible, true, `${section} narrow visible detail`);
    assert.equal(await js("getComputedStyle(document.querySelector('.web-settings-shell')).gridTemplateColumns.split(' ').length"), 1);
    await capture("narrow-en-" + section);
  }
  const panelReport = [];
  console.log('Resource page checks passed; checking all settings panel surfaces.');
  win.setContentSize(1280, 860);
  await js("window.webSettingsPreview.setSidebarWidth(190); window.webSettingsPreview.setLocale('zh-CN')");
  for (const platform of ['mac', 'windows']) {
    await js(`window.webSettingsPreview.setPlatform('${platform}')`);
    for (const mode of ['light', 'dark']) {
      await js(`window.webSettingsPreview.appearance.setThemeMode('${mode}')`);
      await wait(`document.documentElement.dataset.theme === '${mode}'`);
      for (const section of ['general', 'appearance', 'assistant', 'kanban', 'market', 'localServices', 'plugins', 'tunnelHub', 'navigation', 'usage', 'about', 'debug']) {
        await select(section);
        const panels = await js(`(${function () {
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
          const ctx = canvas.getContext('2d');
          return [...document.querySelectorAll('.settings-appearance-panel, .settings-item-card, .settings-pet-card, .settings-page .data-root-card, .settings-page .desktop-update-card.is-settings, .settings-page .service-catalog, .settings-page .management-detail-group, .settings-page .usage-summary-strip, .settings-page .usage-billing-panel')].map(el => {
            const s = getComputedStyle(el);
            ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = s.backgroundColor; ctx.fillRect(0, 0, 1, 1);
            return { className:el.className, background:s.backgroundColor, alpha:ctx.getImageData(0,0,1,1).data[3]/255, opacity:s.opacity, color:s.color };
          });
        }.toString()})()`);
        assert.ok(panels.length, `${section} has panels`);
        for (const panel of panels) {
          assert.ok(panel.alpha > 0 && panel.alpha <= 0.81, `${section} panel background is translucent: ${panel.background}`);
          assert.equal(panel.opacity, '1', `${section} retains text and control opacity`);
        }
        panelReport.push({ platform, mode, section, panels });
        await capture(`panels-${platform}-${mode}-${section}`);
      }
    }
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(root, "report.json"), JSON.stringify({ scope:"isolated real components", checks:report, panels:panelReport, calls:await js("window.webSettingsCalls") }, null, 2));
  console.log("PASS: all four real pages match control center typography, surfaces, radii and compact actions; Desktop search, bridge actions, lifecycle, details, import deduplication and narrow English layout work.");
  win.destroy();
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
