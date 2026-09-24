// Renders the shell's real stylesheets outside Electron so a theme change can be
// reviewed without a full build. The page mirrors how the main window applies a
// skin: data-theme / data-desktop-background on the root node plus the skin's
// tokens as inline custom properties.
//
// Run: node qa/theme-alpha-preview.mjs [--out <file>]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const OUT = outIndex >= 0 ? path.resolve(args[outIndex + 1])
  : path.join(os.tmpdir(), 'theme-alpha-review', 'preview.html');

function inlineCss(file, seen = new Set()) {
  const absolute = path.resolve(file);
  if (seen.has(absolute)) return '';
  seen.add(absolute);
  const source = fs.readFileSync(absolute, 'utf8');
  return source.replace(/@import\s+"([^"]+)";/gu, (_, target) =>
    inlineCss(path.join(path.dirname(absolute), target), seen));
}

function tsSkin(file) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const variants = {};
  for (const mode of ['light', 'dark']) {
    const match = new RegExp(`const ${mode}: SkinTokens = Object\\.freeze\\(\\{(.*?)\\n\\}\\);`, 'su').exec(source);
    if (!match) continue;
    const tokens = {};
    for (const [, key, value] of match[1].matchAll(/"(--[\w-]+)"\s*:\s*"([^"]+)"/gu)) tokens[key] = value;
    variants[mode] = tokens;
  }
  return variants;
}

function packageSkin(file) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  const variants = {};
  for (const mode of ['light', 'dark']) {
    if (manifest.variants?.[mode]?.tokens) variants[mode] = manifest.variants[mode].tokens;
  }
  return { id: manifest.id ?? path.basename(path.dirname(file)), name: manifest.name, variants };
}

const skins = [
  { id: 'default', label: '默认色板', variants: { light: {}, dark: {} } },
  { id: 'mist', label: 'mist（内置）', variants: tsSkin('src/renderer/appearance/skins.ts') },
  { id: 'ocean', label: 'ocean（内置）', variants: tsSkin('src/renderer/appearance/oceanSkin.ts') },
  { id: 'violet', label: 'violet（内置）', variants: tsSkin('src/renderer/appearance/violetSkin.ts') }
];
for (const dir of ['qa/skin-packages', 'output/skin-collection/sources']) {
  const base = path.join(ROOT, dir);
  if (!fs.existsSync(base)) continue;
  for (const entry of fs.readdirSync(base).sort()) {
    const file = path.join(dir, entry, 'skin.json');
    if (!fs.existsSync(path.join(ROOT, file))) continue;
    const parsed = packageSkin(file);
    skins.push({ id: parsed.id, label: `${parsed.name ?? parsed.id}（外部包）`, variants: parsed.variants });
  }
}

// Tokens whose compositing is the point of this review, grouped by the layer
// they paint: shells, panels, controls and states.
const GROUPS = [
  ['外壳层', ['--shell-sidebar-bg', '--shell-content-bg', '--shell-titlebar-bg', '--surface-sidebar']],
  ['表面层', ['--surface', '--surface-strong', '--surface-soft', '--desktop-overlay-panel-bg', '--sidebar-operation-menu-bg']],
  ['面板/输入', ['--accent-soft', '--control-panel-bg', '--control-input-bg', '--control-select-bg', '--control-popover-bg']],
  ['按钮/控件', ['--control-button-bg', '--control-hover-bg', '--control-active-bg', '--control-disabled-bg', '--control-tab-hover-bg']],
  ['描边', ['--line', '--line-strong', '--control-border', '--sidebar-operation-menu-border']],
  ['浮层/状态', ['--nav-selected-bg', '--nav-hover-bg', '--modal-mask-bg', '--sidebar-operation-menu-avatar-bg']]
];

const css = inlineCss(path.join(ROOT, 'src/renderer/styles.css'));
const html = `<!doctype html>
<html lang="zh-CN" data-theme="light" data-desktop-background="image">
<meta charset="utf-8">
<title>主题透明度对照</title>
<style>
${css}
</style>
<style>
body { margin: 0; font: 13px/1.6 -apple-system, "PingFang SC", system-ui; color: #202020; background: #f6f6f7; }
.wrap { padding: 20px 24px 60px; }
h1 { font-size: 17px; font-weight: 600; margin: 0 0 4px; }
.note { color: #666; font-size: 12px; margin: 0 0 16px; }
.bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 0 0 10px; }
.bar b { font-size: 12px; color: #555; font-weight: 600; margin-right: 4px; }
button.pick { font: 12px/1 inherit; padding: 6px 11px; border: 1px solid #d8d8db; border-radius: 8px; background: #fff; cursor: pointer; }
button.pick.on { background: #202020; border-color: #202020; color: #fff; }
.stage { position: relative; margin: 14px 0 26px; border-radius: 16px; overflow: hidden; border: 1px solid #dedee1;
  background: linear-gradient(120deg, #ffd9a8 0%, #7fd4c1 34%, #6d8ce8 68%, #c07ae0 100%); padding: 0; }
.stage.darkwall { background: linear-gradient(120deg, #123a4d 0%, #2a1e4d 45%, #4a1330 100%); }
/* Without an image background the shell never consumes --shell-*-bg: it paints
   its solid fallback instead, so the stage must not offer anything to see through. */
.stage.nowall { background: #edeff2; }
.stage.nowall.darkwall { background: #1a1b1e; }
.shell { display: flex; height: 500px; }
.side { width: 232px; flex: none; padding: 14px; background: var(--shell-sidebar-bg); border-right: 1px solid var(--line);
  color: var(--ink); display: flex; flex-direction: column; gap: 5px; }
.main { flex: 1; min-width: 0; padding: 20px; background: var(--shell-content-bg); color: var(--ink); display: flex; flex-direction: column; gap: 12px; }
.titlebar { height: 30px; display: flex; align-items: center; padding: 0 14px; background: var(--shell-titlebar-bg); color: var(--ink-soft); font-size: 11px; }
.nav { padding: 6px 9px; border-radius: 8px; color: var(--ink-soft); }
.nav.sel { background: var(--nav-selected-bg); color: var(--ink); }
.nav.hov { background: var(--nav-hover-bg); color: var(--ink); }
.card { background: var(--surface-strong); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; color: var(--ink); }
.wash { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; }
.tint { background: var(--accent-soft); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; }
.panel { background: var(--desktop-overlay-panel-bg); border: 1px solid var(--line-strong); border-radius: 12px; padding: 12px 14px; }
.menu { background: var(--sidebar-operation-menu-bg); border: 1px solid var(--sidebar-operation-menu-border); border-radius: 12px; padding: 10px; box-shadow: var(--sidebar-operation-menu-shadow); }
.menu .row { padding: 6px 8px; border-radius: 7px; color: var(--sidebar-operation-menu-text-soft); }
.menu .row:first-child { background: var(--sidebar-operation-menu-hover); color: var(--sidebar-operation-menu-text); }
input, textarea { width: 100%; box-sizing: border-box; padding: 7px 9px; border-radius: 8px;
  border: 1px solid var(--line-strong); background: var(--control-input-bg); color: var(--ink); font: inherit; }
textarea { height: 52px; resize: none; }
.btns { display: flex; gap: 8px; flex-wrap: wrap; }
.btn { padding: 7px 13px; border-radius: 8px; border: 1px solid var(--line-strong); background: var(--control-button-bg); color: var(--ink); }
.btn.hov { background: var(--control-hover-bg); }
.btn.act { background: var(--control-active-bg); }
.btn.off { background: var(--control-disabled-bg); color: var(--ink-muted); }
.btn.primary { background: var(--control-primary-bg); border-color: transparent; color: var(--accent-on); }
.tabs { display: inline-flex; background: var(--control-tab-strip-bg); border-radius: 9px; padding: 3px; gap: 3px; }
.tabs span { padding: 5px 11px; border-radius: 7px; color: var(--ink-soft); }
.tabs .hov { background: var(--control-tab-hover-bg); }
.tabs .on { background: var(--control-tab-active-bg); color: var(--ink); }
/* The mask is shown over its own bounded card rather than as a full-stage veil:
   an always-on veil would tint every layer under review by a constant amount. */
.maskdemo { position: relative; border-radius: 12px; border: 1px solid var(--line); background: var(--surface-strong);
  padding: 12px 14px; color: var(--ink); overflow: hidden; }
.maskdemo .cast { position: absolute; inset: 0; background: var(--modal-mask-bg); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 12px; }
.grid figure { margin: 0; }
.grid figcaption { font-size: 11px; color: #666; margin: 0 0 5px; font-family: ui-monospace, Menlo, monospace; }
.sw { height: 56px; border-radius: 10px; border: 1px solid var(--line); }
table { border-collapse: collapse; font-size: 12px; width: 100%; background: #fff; }
th, td { border: 1px solid #e4e4e7; padding: 4px 8px; text-align: right; font-variant-numeric: tabular-nums; }
th:first-child, td:first-child { text-align: left; font-family: ui-monospace, Menlo, monospace; }
.bad { background: #fdecec; color: #a32d2d; font-weight: 600; }
.ok { background: #eef7f0; color: #2f6b3f; }
html[data-preview-view="stage"] .wrap > *:not(#stage) { display: none; }
html[data-preview-view="stage"] .wrap { padding: 0; }
html[data-preview-view="stage"] #stage { margin: 0; border-radius: 0; border: 0; }
html[data-preview-view="config"] .stage { display: none; }
</style>
<div class="wrap">
  <h1>主题透明度对照</h1>
  <p class="note">真实样式表 + 真实皮肤变量套用方式（root 内联自定义属性）。全部图层叠在所选背景上，透明度差异可直接肉眼比对。</p>
  <div class="bar"><b>皮肤</b><span id="skins"></span></div>
  <div class="bar"><b>模式</b><span id="modes"></span></div>
  <div class="bar"><b>背景</b><span id="walls"></span></div>
  <div class="stage" id="stage">
    <div class="titlebar">标题栏 · --shell-titlebar-bg</div>
    <div class="shell">
      <aside class="side">
        <div class="nav">新建对话</div>
        <div class="nav sel">常用对话（选中 · --nav-selected-bg）</div>
        <div class="nav hov">新的创作灵感（悬停）</div>
        <div class="nav">我的项目</div>
        <div class="menu">
          <div class="row">重命名</div>
          <div class="row">移动到项目</div>
          <div class="row">删除</div>
        </div>
      </aside>
      <section class="main">
        <div class="tabs"><span class="hov">悬停</span><span class="on">选中</span><span>普通</span></div>
        <div class="card">卡片 · --surface-strong</div>
        <div class="wash">弱表面 · --surface（透出壁纸）</div>
        <div class="tint">强调底色 · --accent-soft / --control-panel-bg</div>
        <div class="panel">浮层表面 · --desktop-overlay-panel-bg</div>
        <div class="maskdemo">浮层内容 · 被 --modal-mask-bg 覆盖<span class="cast"></span></div>
        <input value="输入框 · --control-input-bg">
        <textarea>Aa 正文与草稿，检查可读性</textarea>
        <div class="btns">
          <span class="btn">按钮</span><span class="btn hov">悬停</span><span class="btn act">按下</span>
          <span class="btn off">禁用</span><span class="btn primary">主按钮</span>
        </div>
      </section>
    </div>
  </div>
  <div class="grid" id="swatches"></div>
  <h1 style="margin-top:26px">解析后的透明度</h1>
  <p class="note" id="selfcheck"></p>
  <div id="table"></div>
</div>
<script type="application/json" id="report"></script>
<script>
const GROUPS = ${JSON.stringify(GROUPS)};
const SKINS = ${JSON.stringify(skins)};
const root = document.documentElement;
let skin = SKINS[0], mode = 'light', bg = 'image';
const WALLS = [
  { id: 'image', label: '壁纸（--shell-*-bg 生效）' },
  { id: 'none', label: '无壁纸（外壳走实色）' }
];
const applied = [];
function applySkin() {
  for (const key of applied) root.style.removeProperty(key);
  applied.length = 0;
  Object.assign(root.dataset, {
    theme: mode, desktopSkin: skin.id,
    desktopBackground: bg, desktopBackgroundSource: bg === 'image' ? 'skin' : 'none'
  });
  for (const [key, value] of Object.entries(skin.variants[mode] ?? {})) {
    root.style.setProperty(key, value);
    applied.push(key);
  }
  const stage = document.getElementById('stage');
  stage.classList.toggle('darkwall', mode === 'dark');
  stage.classList.toggle('nowall', bg === 'none');
  render();
}
// Mirrors the renderer's own resolver (webclientProjection): paint one pixel on
// a canvas so every CSS colour form, including color-mix, yields a concrete alpha.
const probe = document.createElement('canvas');
probe.width = probe.height = 1;
const probeCtx = probe.getContext('2d', { willReadFrequently: true });
function alpha(value) {
  if (!value || !probeCtx) return null;
  probeCtx.clearRect(0, 0, 1, 1);
  probeCtx.fillStyle = '#000';
  probeCtx.fillStyle = value;
  probeCtx.fillRect(0, 0, 1, 1);
  return Number((probeCtx.getImageData(0, 0, 1, 1).data[3] / 255).toFixed(4));
}
function token(name) { return getComputedStyle(root).getPropertyValue(name).trim(); }
function render() {
  document.getElementById('swatches').innerHTML = GROUPS.map(([group, tokens]) => tokens.map(name => {
    const value = token(name);
    return '<figure><figcaption>' + name + ' = ' + value + '</figcaption>' +
      '<div class="sw" style="background:' + (value || 'transparent') + '"></div></figure>';
  }).join('')).join('');
  const rows = [];
  let mismatches = 0;
  for (const [group, tokens] of GROUPS) {
    for (const name of tokens) {
      const value = token(name);
      const resolved = alpha(value);
      const declared = alpha(value) === null ? '—' : resolved.toFixed(2);
      rows.push('<tr><td>' + name + '</td><td>' + declared + '</td><td>' + value + '</td></tr>');
    }
  }
  document.getElementById('table').innerHTML =
    '<table><thead><tr><th>变量</th><th>生效 alpha</th><th>生效值</th></tr></thead><tbody>' + rows.join('') + '</tbody></table>';
  document.getElementById('selfcheck').textContent =
    '当前 ' + skin.label + ' · ' + mode + '。生效 alpha 由浏览器解析 root 上的最终计算值得到，可与静态校验脚本对照。';
  document.getElementById('report').textContent = JSON.stringify({ skin: skin.id, label: skin.label, mode, bg, alphas: window.themePreview.alphas() });
  document.getElementById('skins').innerHTML = SKINS.map((entry, index) =>
    '<button class="pick' + (entry.id === skin.id ? ' on' : '') + '" data-skin="' + index + '">' + entry.label + '</button>').join('');
  document.getElementById('modes').innerHTML = ['light', 'dark'].map(value =>
    '<button class="pick' + (value === mode ? ' on' : '') + '" data-mode="' + value + '">' + value + '</button>').join('');
  document.getElementById('walls').innerHTML = WALLS.map(entry =>
    '<button class="pick' + (entry.id === bg ? ' on' : '') + '" data-wall="' + entry.id + '">' + entry.label + '</button>').join('');
}
document.getElementById('skins').onclick = event => {
  const index = event.target.dataset?.skin;
  if (index === undefined) return;
  skin = SKINS[Number(index)];
  applySkin();
};
document.getElementById('modes').onclick = event => {
  const next = event.target.dataset?.mode;
  if (!next) return;
  mode = next;
  applySkin();
};
document.getElementById('walls').onclick = event => {
  const next = event.target.dataset?.wall;
  if (!next) return;
  bg = next;
  applySkin();
};
// Query parameters let a headless run select one configuration without clicking.
const params = new URLSearchParams(location.search);
if (params.has('skin')) {
  const found = SKINS.find(entry => entry.id === params.get('skin'));
  if (found) skin = found;
}
if (params.get('mode') === 'dark') mode = 'dark';
if (params.get('bg') === 'none') bg = 'none';
if (params.has('view')) root.dataset.previewView = params.get('view');
window.themePreview = {
  select(id, nextMode, nextBg) {
    const found = SKINS.find(entry => entry.id === id);
    if (found) skin = found;
    if (nextMode) mode = nextMode;
    if (nextBg) bg = nextBg;
    applySkin();
  },
  alphas() {
    const result = {};
    for (const [, tokens] of GROUPS) for (const name of tokens) result[name] = alpha(token(name));
    return result;
  },
  report() {
    return { skin: skin.id, mode, bg, alphas: window.themePreview.alphas() };
  },
  skins: SKINS.map(entry => entry.id)
};
applySkin();
</script>
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);
console.log(JSON.stringify({ out: OUT, bytes: html.length, skins: skins.map(skin => skin.id) }, null, 2));
