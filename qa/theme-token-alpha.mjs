// Alpha contract for theme colour tokens.
//
// Rule: a token name carries its semantics, so its alpha is part of the
// token contract. Changing theme mode or skin may change the RGB channels but
// must not change how transparent the token is.
//
//   - built-in theme (theme.css + bundled skins): enforced
//   - external skin packages: reported only, so authors can migrate
//
// Run: node qa/theme-token-alpha.mjs [--json] [--report <dir>]

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const asJson = args.includes('--json');

// Some values are not translucent layers at all. For these the same alpha does
// not read the same way over a light and a dark backdrop, so the mode-specific
// value is the correct one and the token is exempt from the cross-mode rule.
const OPTICAL_EXEMPT = new Set([
  '--panel-shadow', '--panel-shadow-hover', '--sidebar-operation-menu-shadow',
  '--control-thumb-shadow', '--accent-glow', '--accent-shadow',
  '--accent-shadow-soft', '--accent-shadow-strong'
]);

// Everything else must keep one alpha across light and dark. A token that needs
// to differ has to be registered here with its reason, so the asymmetry is a
// decision instead of an accident.
const NEUTRAL_LIFT = '中性提亮量：深色以低 alpha 白色叠加表达层级，浅色是可读面';
const STROKE_VISIBILITY = '深色需要更高描边浓度才与浅色等距可见';
const DECLARED_ASYMMETRY = new Map([
  ['--control-button-bg', NEUTRAL_LIFT],
  ['--control-tab-hover-bg', NEUTRAL_LIFT],
  ['--control-disabled-bg', NEUTRAL_LIFT],
  ['--control-hover-bg', NEUTRAL_LIFT],
  ['--control-active-bg', NEUTRAL_LIFT],
  ['--nav-hover-bg', NEUTRAL_LIFT],
  ['--nav-selected-bg', NEUTRAL_LIFT],
  ['--sidebar-operation-menu-hover', NEUTRAL_LIFT],
  ['--sidebar-operation-menu-avatar-bg', NEUTRAL_LIFT],
  ['--sidebar-operation-menu-border', STROKE_VISIBILITY],
  ['--shell-content-bg', '深色工作区需要更多衬底，保障浅色文字可读'],
  ['--desktop-ui-border', '辅助窗口沿用 desktop-ui 的实色/半透明两套取值'],
  ['--desktop-ui-border-soft', '辅助窗口沿用 desktop-ui 的实色/半透明两套取值'],
  ['--embedded-surface-page-bg', '刻意保留极小实色差以防路由切换闪动'],
  ['--embedded-surface-dock-bg', '刻意保留极小实色差以防路由切换闪动'],
  ['--bg-canvas', '浅色为透明，深色为画布渐变，非颜色 token']
]);

const BUILTIN_SKINS = [
  { id: 'default', source: 'src/renderer/styles/theme.css' },
  { id: 'mist', source: 'src/renderer/appearance/skins.ts' },
  { id: 'ocean', source: 'src/renderer/appearance/oceanSkin.ts' },
  { id: 'violet', source: 'src/renderer/appearance/violetSkin.ts' }
];

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

function cssBlock(file, selector) {
  const source = read(file);
  const at = source.indexOf(selector);
  if (at < 0) return {};
  const open = source.indexOf('{', at);
  let depth = 0;
  let close = open;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) { close = i; break; }
    }
  }
  const tokens = {};
  for (const [, key, value] of source.slice(open + 1, close).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/gu)) {
    tokens[key] = value.trim();
  }
  return tokens;
}

function tsSkin(file) {
  const source = read(file);
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
  const manifest = JSON.parse(read(file));
  const variants = {};
  for (const mode of ['light', 'dark']) {
    const tokens = manifest.variants?.[mode]?.tokens;
    if (tokens) variants[mode] = tokens;
  }
  return { id: manifest.id, name: manifest.name, variants };
}

// Split on the commas that separate a colour's arguments, ignoring any comma
// nested inside parentheses so that a var() argument stays whole. Without this,
// rgba(var(--accent-rgb), var(--alpha-accent-soft)) splits into two pieces and
// the alpha slot is never read.
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) { parts.push(current.trim()); current = ''; continue; }
    current += char;
  }
  parts.push(current.trim());
  return parts;
}

// Resolve one alpha slot: either a var(--alpha-*) reference or a literal, which
// may be written as a fraction (0.58) or a percentage (58%).
function alphaChannel(text, variant, depth) {
  const reference = /^var\((--[\w-]+)\)$/u.exec(text);
  if (reference) {
    const next = variant[reference[1]];
    return next === undefined ? null : alphaOf(next, variant, depth + 1);
  }
  const numeric = Number.parseFloat(text);
  if (!Number.isFinite(numeric)) return null;
  return numeric > 1 ? numeric / 100 : numeric;
}

// Split a colour value into its channels and alpha. The variant map already
// contains the resolved cascade, so var() lookups only need that one map.
function alphaOf(value, variant, depth = 0) {
  if (depth > 4 || typeof value !== 'string') return null;
  const text = value.trim();
  const reference = /^var\((--[\w-]+)\)$/u.exec(text);
  if (reference) {
    const next = variant[reference[1]];
    return next === undefined ? null : alphaOf(next, variant, depth + 1);
  }
  if (text === 'transparent') return 0;
  // The template stores bare alphas, so a resolved reference lands here.
  if (/^(?:0|1|0?\.\d+)$/u.test(text)) return Number.parseFloat(text);
  if (/^#[0-9a-f]{4}$/iu.test(text)) return Number.parseInt(text[4], 16) / 15;
  if (/^#[0-9a-f]{8}$/iu.test(text)) return Number.parseInt(text.slice(7, 9), 16) / 255;
  if (/^#[0-9a-f]{3}$|^#[0-9a-f]{6}$/iu.test(text)) return 1;
  // Greedy capture: the alpha slot can itself be a var(), which contains ')'.
  const rgb = /^rgba?\((.*)\)$/isu.exec(text);
  if (rgb) {
    const parts = splitTopLevel(rgb[1]);
    // rgba(r, g, b, <alpha>) — legacy literal or the rgba(<rgb>, var(--alpha-x)) template.
    if (parts.length === 4) return alphaChannel(parts[3], variant, depth);
    // rgba(var(--rgb), <alpha>) — the channels are carried by a var(), so the
    // alpha is the second argument and may itself be a var().
    if (parts.length === 2 && parts[0].startsWith('var(')) return alphaChannel(parts[1], variant, depth);
    return parts.length === 3 ? 1 : null;
  }
  const mix = /^color-mix\(in srgb,\s*(.*)\s+([\d.]+)%,\s*transparent\)$/isu.exec(text);
  if (mix) {
    const base = alphaOf(mix[1], variant, depth + 1);
    return base === null ? null : Number.parseFloat((base * Number.parseFloat(mix[2]) / 100).toFixed(4));
  }
  return null;
}

function collect() {
  // theme.css is the base cascade: :root always applies, the dark block
  // overrides it. Skins (bundled modules and installed packages alike) are
  // inline overrides on the document root, so their variant is the base plus
  // their own tokens — which is also why a token's *effective* alpha can drift
  // even when the skin never mentions it.
  const baseLight = cssBlock('src/renderer/styles/theme.css', ':root {');
  const baseDark = { ...baseLight, ...cssBlock('src/renderer/styles/theme.css', ':root[data-theme="dark"]') };
  const loaded = [];
  for (const skin of BUILTIN_SKINS) {
    const variants = skin.source.endsWith('.css') ? { } : tsSkin(skin.source);
    loaded.push({
      id: skin.id, kind: 'builtin', file: skin.source,
      variants: {
        light: { ...baseLight, ...(variants.light ?? {}) },
        dark: { ...baseDark, ...(variants.dark ?? {}) }
      }
    });
  }
  const sources = [...loaded];
  for (const dir of ['qa/skin-packages', 'output/skin-collection/sources']) {
    const base = path.join(ROOT, dir);
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base).sort()) {
      const file = path.join(dir, entry, 'skin.json');
      if (!fs.existsSync(path.join(ROOT, file))) continue;
      const parsed = packageSkin(file);
      sources.push({
        id: parsed.id ?? entry, kind: 'external', file,
        variants: {
          light: { ...baseLight, ...(parsed.variants.light ?? {}) },
          dark: { ...baseDark, ...(parsed.variants.dark ?? {}) }
        }
      });
    }
  }
  const rows = new Map();
  for (const source of sources) {
    for (const mode of ['light', 'dark']) {
      const variant = source.variants[mode];
      for (const [token, value] of Object.entries(variant)) {
        // --alpha-* are the template itself: their per-mode difference is the
        // declaration, and the tokens that consume them are checked instead.
        if (token.startsWith('--alpha-')) continue;
        if (!rows.has(token)) rows.set(token, { token, values: [] });
        const previous = rows.get(token).values.find(entry => entry.source === source.id && entry.mode === mode);
        const entry = { source: source.id, kind: source.kind, mode, value, alpha: alphaOf(value, variant, variant) };
        if (previous) Object.assign(previous, entry);
        else rows.get(token).values.push(entry);
      }
    }
  }
  return { sources, rows, baseLight, baseDark };
}

function format(alpha) {
  return alpha === null || alpha === undefined ? '  ?  ' : alpha.toFixed(2);
}

function main() {
  const { sources, rows } = collect();
  const builtinIds = new Set(sources.filter(source => source.kind === 'builtin').map(source => source.id));
  const violations = [];
  const report = [];

  for (const { token, values } of rows.values()) {
    const entries = values.filter(entry => entry.alpha !== null);
    if (entries.length === 0) continue;
    const builtin = entries.filter(entry => builtinIds.has(entry.source));
    // Every built-in skin must agree with the others for the same mode.
    for (const mode of ['light', 'dark']) {
      const scoped = builtin.filter(entry => entry.mode === mode);
      const unique = [...new Set(scoped.map(entry => entry.alpha))];
      if (unique.length > 1) {
        violations.push({
          token, rule: 'cross-skin', mode,
          detail: scoped.map(entry => `${entry.source}=${format(entry.alpha)}`).join(', ')
        });
      }
    }
    // The same token must not change its alpha with the theme mode. A token that
    // provably needs to differ is registered in DECLARED_ASYMMETRY; shadows and
    // glows are optical and never subject to the rule.
    const light = builtin.find(entry => entry.mode === 'light');
    const dark = builtin.find(entry => entry.mode === 'dark');
    if (light && dark && light.alpha !== null && dark.alpha !== null && light.alpha !== dark.alpha &&
      !OPTICAL_EXEMPT.has(token) && !DECLARED_ASYMMETRY.has(token)) {
      violations.push({
        token, rule: 'undeclared-asymmetry',
        detail: `light=${format(light.alpha)} (${light.source}), dark=${format(dark.alpha)} (${dark.source}) — 要么统一，要么登记到 DECLARED_ASYMMETRY`
      });
    }
    const modes = new Map();
    for (const entry of entries) {
      if (!modes.has(entry.source)) modes.set(entry.source, {});
      modes.get(entry.source)[entry.mode] = entry.alpha;
    }
    report.push({
      token,
      values: [...modes].map(([source, byMode]) => ({ source, ...byMode })),
      note: OPTICAL_EXEMPT.has(token) ? '光学量' : DECLARED_ASYMMETRY.get(token) ?? null
    });
  }

  const external = [];
  for (const { token, values } of rows.values()) {
    if (OPTICAL_EXEMPT.has(token) || DECLARED_ASYMMETRY.has(token)) continue;
    const drift = values.filter(entry => entry.kind === 'external');
    const builtin = values.find(entry => entry.kind === 'builtin' && entry.alpha !== null);
    if (!builtin || drift.length === 0) continue;
    const other = drift.filter(entry => entry.alpha !== null && entry.alpha !== builtin.alpha);
    if (other.length) {
      external.push({ token, canonical: builtin.alpha, others: other.map(entry => `${entry.source}=${format(entry.alpha)}`) });
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ violations, report, external }, null, 2));
  } else {
    console.log(`内置来源: ${[...builtinIds].join(', ')}`);
    console.log(`样本总数: ${sources.length} 个变体 / ${rows.size} 个变量\n`);
    console.log('变量'.padEnd(36) + '内置(浅/深)'.padEnd(14) + '外部包');
    for (const entry of report) {
      const own = entry.values.find(value => builtinIds.has(value.source));
      const others = entry.values.filter(value => !builtinIds.has(value.source))
        .flatMap(value => [value.light, value.dark].filter(alpha => alpha !== undefined))
        .map(alpha => format(alpha));
      console.log(
        entry.token.padEnd(36) +
        `${format(own?.light)} / ${format(own?.dark)}`.padEnd(14) +
        [...new Set(others)].join(' ') + (entry.note ? `   [${entry.note}]` : '')
      );
    }
    if (violations.length) {
      console.log('\n=== 违规 ===');
      for (const item of violations) console.log(`[${item.rule}] ${item.token}${item.mode ? ` (${item.mode})` : ''}: ${item.detail}`);
    }
    if (external.length) {
      console.log('\n=== 外部皮肤包偏离（仅提示，不阻断）===');
      for (const item of external) console.log(`${item.token}: 规范 ${format(item.canonical)} <- ${item.others.join(', ')}`);
    }
    console.log(`\n违规 ${violations.length} 项，外部偏离 ${external.length} 项`);
  }
  process.exitCode = violations.length ? 1 : 0;
}

main();
