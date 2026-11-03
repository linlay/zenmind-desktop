const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = process.env.DESKTOP_BACKGROUND_TEST_ROOT;
for (const name of ["home", "appData", "userData", "sessionData"]) {
  const directory = path.join(root, name); fs.mkdirSync(directory, { recursive: true }); app.setPath(name, directory);
}
if (process.platform === "darwin") app.setActivationPolicy("prohibited");

(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1000, height: 700,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const diagnostics = [];
  win.webContents.on("console-message", event => { if (event.level === "error") diagnostics.push(event.message); });
  const js = code => win.webContents.executeJavaScript(code);
  async function frames(count = 2) {
    await js(`new Promise(resolve => { let count = ${count}; const next = () => --count ? requestAnimationFrame(next) : resolve(); requestAnimationFrame(next); })`);
  }
  async function until(code, label) {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (await js(`Boolean(${code})`)) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`${label}\n${await js("JSON.stringify(window.backgroundRoutingFixture?.sample?.())")}\n${diagnostics.join("\n")}`);
  }
  const sample = () => js("backgroundRoutingFixture.sample()");
  const api = expression => js(`backgroundRoutingFixture.api.${expression}`);
  function sameImage(before, after, label) {
    assert.equal(after.image.node, before.image.node, `${label}: image node changed`);
    assert.equal(after.image.src, before.image.src, `${label}: image src changed`);
    assert.equal(after.image.loads, before.image.loads, `${label}: image reloaded`);
    assert.equal(after.image.state, "ready", `${label}: image returned to loading`);
    assert.equal(after.image.visibility, "visible", `${label}: wallpaper hidden`);
  }
  function transparent(state, label, layers = ["content", "main", "guest", "frameShell", "frame"]) {
    for (const layer of layers) {
      assert.ok(state[layer], `${label}: ${layer} is missing`);
      assert.equal(state[layer].backgroundAlpha, 0, `${label}: ${layer} must be transparent (${state[layer].background})`);
    }
  }
  await win.loadFile(path.join(root, "index.html"), { hash: "/kanban" });
  await until("backgroundRoutingFixture?.sample?.().image.state === 'ready'", "initial wallpaper did not load");
  const initial = await sample(), lazyTransitions = [];
  for (const [target, previous, newBoundary] of [["kbases", "kanban", false], ["automations", "kbases", true]]) {
    await api(`setNewBoundary(${newBoundary})`); await frames();
    await api(`navigate('/${target}')`);
    await until(`backgroundRoutingFixture.lazyRequests.includes('${target}')`, "lazy route was not requested");
    await frames(4);
    const early = await sample(); sameImage(initial, early, `early ${target}`);
    assert.equal(early.content.backdrop, "none", "the previous committed surface must not add blur either");
    await until(`backgroundRoutingFixture.sample().route === '/${target}'`, "the target route did not commit its pending shell");
    const pending = await sample();
    // Content can show a placeholder or Suspense's null fallback. Wallpaper
    // composition must already match the eligible target before it mounts.
    assert.equal(pending.route, `/${target}`);
    assert.match(pending.rootClass, /has-webclient-background-surface/u);
    assert.equal(pending.content.backdrop, "none", "a cold eligible route must not blur wallpaper while its chunk is loading");
    transparent(pending, `cold ${target}`, ["content", "main"]);
    sameImage(initial, pending, `slow ${target}`);
    await api(`release('${target}')`);
    await until(`backgroundRoutingFixture.sample().visiblePages.includes('${target}')`, "lazy route did not commit");
    const ready = await sample(); sameImage(initial, ready, `committed ${target}`);
    assert.equal(ready.content.backdrop, pending.content.backdrop);
    assert.equal(ready.main.background, pending.main.background);
    lazyTransitions.push({ target, previous, newBoundary, early, pending, ready });
  }

  const surfaces = [], negatives = [];
  for (const platform of ["mac", "windows"]) for (const theme of ["light", "dark"]) {
    await api(`setOptions(${JSON.stringify({ platform, theme, image: true, active: true, hidden: false, supported: true, service: "agent-webclient", role: "service" })})`);
    await api("navigate('/kbases')"); await api("setBridgeReady(false)"); await frames(3);
    const pending = await sample();
    assert.match(pending.guestClass, /agent-webclient-background-surface/u);
    assert.doesNotMatch(pending.guestClass, /agent-webclient-host-background/u);
    assert.equal(pending.content.backdrop, "none", `${platform}/${theme} pending guest must not blur wallpaper`);
    transparent(pending, `${platform}/${theme} pending`);
    for (let count = 0; count < 20; count++) { await api("bumpBusiness()"); await frames(); }
    sameImage(initial, await sample(), `${platform}/${theme} business updates`);
    await api("setBridgeReady(true)"); await frames(3); const ready = await sample();
    assert.equal(ready.content.backdrop, pending.content.backdrop);
    assert.equal(ready.main.background, pending.main.background);
    transparent(ready, `${platform}/${theme} ready`);
    sameImage(initial, ready, `${platform}/${theme} bridge ready`);

    await api("navigate('/kanban')"); await frames(3); const kanban = await sample();
    assert.equal(kanban.content.backdrop, "none"); assert.equal(kanban.toolbar.backdrop, "none", "wallpaper Kanban toolbar must not add a second blur plane");
    assert.notEqual(kanban.main.background, "rgba(0, 0, 0, 0)", "Kanban must keep its reading veil");
    await api("navigate('/kbases')"); await frames(3);
    surfaces.push({ platform, theme, pending, ready, kanban });

    for (const options of [{ hidden: true }, { active: false }, { supported: false }, { role: "copilot-dock" }, { service: "another-service" }]) {
      await api(`setOptions(${JSON.stringify({ active: true, hidden: false, supported: true, service: "agent-webclient", role: "service", ...options })})`);
      await frames(3); const negative = await sample();
      assert.match(negative.content.backdrop, /blur\(8px\)/u, `${platform}/${theme} ${JSON.stringify(options)} must retain the existing non-wallpaper guest surface`);
      assert.doesNotMatch(negative.rootClass, /has-webclient-background-surface/u);
      assert.ok(negative.frame.backgroundAlpha > 0, "excluded guest keeps its frame-owned reading surface");
      negatives.push({ platform, theme, options, content: negative.content, main: negative.main, guestClass: negative.guestClass });
    }
    await api(`setOptions(${JSON.stringify({ image: false, active: true, hidden: false, supported: true, service: "agent-webclient", role: "service" })})`); await frames(3);
    const noImage = await sample(); assert.equal(noImage.image.count, 0); assert.match(noImage.content.backdrop, /blur\(8px\)/u);
    assert.ok(noImage.frame.backgroundAlpha > 0, "without wallpaper the guest frame reading surface must remain opaque");
    negatives.push({ platform, theme, options: { image: false }, content: noImage.content, main: noImage.main });
    await api("navigate('/kanban')"); await frames(3);
    assert.match((await sample()).toolbar.backdrop, /blur\(18px\)/u, "Kanban's no-image toolbar must preserve its original backdrop");
    await api("navigate('/kbases')"); await frames(3);
    await api("setOptions({image:true})"); await frames(3); await until("backgroundRoutingFixture.sample().image.state === 'ready'", "wallpaper failed to restore");
    // Toggling wallpaper intentionally recreates the decoration. Later cases
    // compare against this new stable node instead of the first one.
    Object.assign(initial, await sample());
  }
  assert.deepEqual(await js("backgroundRoutingFixture.errors"), []); assert.deepEqual(diagnostics, []);
  fs.writeFileSync(path.join(root, "passed.json"), JSON.stringify({ ok: true,
    electron: process.versions.electron, nativePlatform: process.platform,
    scope: "Windows cases exercise Chromium CSS branches; native Windows composition is outside this test.",
    lazyTransitions, surfaces, negatives, rendererErrors: diagnostics }, null, 2));
  win.destroy(); app.exit(0);
})().catch(error => { console.error(error.stack || error); app.exit(1); });
