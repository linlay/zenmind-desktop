import fs from 'node:fs';
import { themedGeometry, themedOutlines, drawThemedHeading } from './themed-artwork.mjs';
import { kittyPaths, drawKittyHeading, kittyUnreadOutline } from './kitty-artwork.mjs';
import path from 'node:path';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';

export function registerCollectionFonts(explicitFont) {
  let sans = explicitFont, serif = explicitFont;
  if (!sans && process.platform === 'darwin') { sans = '/System/Library/Fonts/STHeiti Medium.ttc'; serif = '/System/Library/Fonts/Supplemental/Songti.ttc'; }
  if (!sans && process.platform === 'win32') { const root = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts'); sans = path.join(root, 'msyh.ttc'); serif = path.join(root, 'simsun.ttc'); }
  if (!sans || !fs.existsSync(sans) || !GlobalFonts.registerFromPath(sans, 'CollectionSans')) throw new Error('Provide --font with a Chinese-capable font.');
  if (!serif || !fs.existsSync(serif) || !GlobalFonts.registerFromPath(serif, 'CollectionSerif')) throw new Error('Missing Chinese serif font.');
}

export const paths = {
  sidebar_right: '<rect x="3" y="4" width="18" height="16" rx="4"/><path d="M15 4v16"/>',
  chat: '<path d="M5 4h14a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H9l-6 3V7a3 3 0 0 1 2-3Z"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m14.5 14.5 5 5"/>',
  back: '<path d="M20 12H4m6-6-6 6 6 6"/>', forward: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="4"/><path d="M9 4v16"/>',
  kanban: '<rect x="3" y="4" width="18" height="17" rx="4"/><path d="M7 9v7m5-7v4m5-4v9"/>',
  automation: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/>',
  new_chat: '<path d="M10 5H6a3 3 0 0 0-3 3v11a2 2 0 0 0 2 2h12a3 3 0 0 0 3-3v-4M10 14l1-4 8-8 3 3-8 8-4 1"/>',
  project: '<path d="M3 9V7a3 3 0 0 1 3-3h4l3 4h5a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3Z"/>',
  website: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  send: '<path d="M12 20V5M5 12l7-7 7 7"/>', stop: '<rect x="6" y="6" width="12" height="12" rx="3"/>',
  attach: '<path d="M12 4v16M4 12h16"/>', expand: '<path d="M4 9V4h5m6 0h5v5M4 15v5h5m6 0h5v-5"/>',
  collapse: '<path d="M9 4v5H4m11-5v5h5M9 20v-5H4m11 5v-5h5"/>',
  voice: '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M6 11v2a6 6 0 0 0 12 0v-2M12 19v3m-4 0h8"/>',
  terminal: '<rect x="3" y="5" width="18" height="15" rx="3"/><path d="m7 10 3 3-3 3m6 0h4"/>',
  database: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 4 16 4 16 0V6M4 12c0 4 16 4 16 0"/>',
  library: '<path d="M12 6Q6 2 3 5v15q4-3 9 0 5-3 9 0V5q-3-3-9 1v14"/>',
  refresh: '<path d="M20 10a8 8 0 1 0 0 6M20 3v7h-7"/>', more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'
};
const mapping = { 'navigation.search':'search','navigation.back':'back','navigation.forward':'forward','navigation.sidebar_left':'sidebar','navigation.sidebar_right':'sidebar_right','navigation.refresh':'refresh','navigation.more_actions':'more','entry.kanban':'kanban','entry.automation':'automation','entry.new_chat':'new_chat','entry.new_project':'project','entry.chat':'chat','entry.project':'project','entry.website':'website','chat.send':'send','chat.stop':'stop','chat.attach':'attach','chat.expand':'expand','chat.collapse':'collapse','chat.voice':'voice','agent.default':'project','agent.terminal':'terminal','agent.database':'database','agent.library':'library','agent.folder':'project','agent.coder':'terminal','agent.kbase':'library' };

export const COLLECTION_STYLES = {
  'pink-kitty': { label: '猫爪 · 猫耳 · 猫尾', motif: 'bow', rounded: true },
  'tahiti': { label: '山海 · 海龟 · 神秘岛纹', motif: 'palm', rounded: true },
  'gold-saints': { label: '射手座 · 黄金翼甲 · 圣斗士', motif: 'star', rounded: false },
  'walnut-song': { label: '榫卯 · 木作 · 宋式书卷', motif: 'lattice', rounded: false }
};
export async function createCollectionArtwork(manifest, key) {
  const design = COLLECTION_STYLES[key];
  if (!design) throw new Error(`Unknown collection theme: ${key}`);
  const files = new Map();
  const next = structuredClone(manifest); next.schemaVersion = '1.1'; next.version = key === 'pink-kitty' ? '1.1.1' : key === 'gold-saints' ? '1.2.2' : '1.2.1';
  for (const mode of ['light', 'dark']) {
    const tokens = next.variants[mode].tokens;
    const color = tokens['--control-icon-color'], accent = tokens['--accent'], ink = tokens['--ink'];
    const images = {};
    for (const [name, original] of Object.entries(paths)) {
      const geometry = key === 'pink-kitty' ? kittyPaths[name] : themedGeometry(key, name, original);
      const stroke = name === 'send' ? tokens['--accent-on'] : name === 'stop' ? (mode === 'light' ? '#BA3452' : '#FF9BAF') : color;
      const motif = '';
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="${key === 'pink-kitty' ? '0 0 24 24' : '-2 -2 28 28'}" color="${stroke}"><g fill="none" stroke="${stroke}" stroke-width="${design.rounded ? 1.8 : 1.6}" stroke-linecap="${design.rounded ? 'round' : 'square'}" stroke-linejoin="${design.rounded ? 'round' : 'miter'}">${geometry}</g>${motif}</svg>`;
      const canvas = createCanvas(96, 96);canvas.getContext('2d').drawImage(await loadImage(Buffer.from(svg)), 0, 0);
      files.set(`visuals/${mode}-${name}.png`, canvas.toBuffer('image/png'));
    }
    for (const [slot, name] of Object.entries(mapping)) images[slot] = `visuals/${mode}-${name}.png`;
    if (key === 'pink-kitty') {
      for (const slot of ['chat.attach', 'navigation.refresh', 'entry.new_project']) delete images[slot];
      for (const name of ['attach', 'refresh']) files.delete(`visuals/${mode}-${name}.png`);
    }
    for (const [group, zh, en] of [['pinned', '置顶', 'Pinned'], ['chats', '对话', 'Chats'], ['projects', '项目', 'Projects'], ['websites', '站点', 'Sites']]) {
      for (const [locale, label] of [['zh-CN', zh], ['en-US', en]]) {
        const font = `bold 62px "${design.rounded ? 'CollectionSans' : 'CollectionSerif'}"`;
        const probe = createCanvas(1, 1).getContext('2d');probe.font = font;
        const width = Math.ceil(probe.measureText(label).width + 68);
        const canvas = createCanvas(width, 104), ctx = canvas.getContext('2d');ctx.font = font;ctx.textBaseline = 'middle';
        if (key === 'pink-kitty') { drawKittyHeading(ctx, label, ink, accent, tokens['--bg-base']); } else {
        await drawThemedHeading(ctx, {key,label,ink,accent,background:tokens['--bg-base'],width,loadImage});
        }
        const filename = `visuals/${mode}-${group}-${locale}.png`;files.set(filename, canvas.toBuffer('image/png'));images[`heading.${group}.${locale}`] = filename;
      }
    }
    next.variants[mode].visuals = { images, styles: {
      unread: accent, unreadText: tokens['--accent-on'], unreadShape: 'circle',
      unreadOutline: key === 'pink-kitty' ? kittyUnreadOutline : themedOutlines[key],
      badgeShape: design.rounded ? 'round' : 'pill', headingStyle: design.rounded ? 'rounded' : 'default'
    } };
  }
  return { manifest: next, files };
}
