// Reproducible artwork for the 1.1 reference pack. Optional --base preserves an existing pack's wallpaper/palette.
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const output = path.resolve(option('--output') ?? 'build/qa/bow-1.1.skin.zip');
const zip = new JSZip();
let fontPath = option('--font');
if (!fontPath && process.platform === 'darwin') fontPath = '/System/Library/Fonts/STHeiti Medium.ttc';
if (!fontPath && process.platform === 'win32') fontPath = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts', 'msyh.ttc');
if (!fontPath || !fs.existsSync(fontPath) || !GlobalFonts.registerFromPath(fontPath, 'SkinHeading')) throw new Error('Provide --font with a Chinese-capable TTF/TTC font');
let manifest = { schemaVersion: '1.1', id: 'bow.blush', name: '蝴蝶结 · 1.1', version: '1.1.0', variants: {
  light: { tokens: { '--bg-base': '#fff0f5', '--surface': '#fff5f8', '--surface-sidebar': '#fce9f0', '--shell-sidebar-bg': '#fce9f0', '--shell-content-bg': '#fff0f5', '--shell-titlebar-bg': '#fce9f0', '--ink': '#563546', '--ink-soft': '#805168', '--ink-muted': '#94627a', '--accent': '#cb6a93', '--accent-on': '#ffffff', '--control-icon-color': '#805168', '--control-primary-bg': '#cb6a93', '--control-primary-hover': '#b7477b' } },
  dark: { tokens: { '--bg-base': '#281d28', '--surface': '#342431', '--surface-sidebar': '#30202e', '--shell-sidebar-bg': '#30202e', '--shell-content-bg': '#281d28', '--shell-titlebar-bg': '#30202e', '--ink': '#ffe5f1', '--ink-soft': '#edb5ce', '--ink-muted': '#c48ba5', '--accent': '#f18cba', '--accent-on': '#2c1524', '--control-icon-color': '#edb5ce', '--control-primary-bg': '#f18cba', '--control-primary-hover': '#ffafcf' } }
} };
if (option('--base')) {
  const data = fs.readFileSync(path.resolve(option('--base')));
  if (data.length > 32 * 1024 * 1024) throw new Error('Base pack exceeds 32 MiB');
  const base = await JSZip.loadAsync(data);
  const name = Object.keys(base.files).find(name => /^(?:[^/]+\/)?skin\.json$/.test(name));
  if (!name) throw new Error('Missing skin.json');
  manifest = JSON.parse(await base.file(name).async('string'));
  const prefix = name.slice(0, -9);
  for (const name of new Set([manifest.preview, ...Object.values(manifest.variants).map(v => v.background?.path)].filter(Boolean))) {
    const file = base.file(prefix + name); if (!file) throw new Error(`Missing base resource: ${name}`);
    zip.file(name, await file.async('nodebuffer'));
  }
  manifest = { ...manifest, schemaVersion: '1.1', version: '1.1.0', name: manifest.name.replace(/ · 1\.1$/, '') + ' · 1.1' };
}
const paths = {
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
const mapping = { 'navigation.search':'search','navigation.back':'back','navigation.forward':'forward','navigation.sidebar_left':'sidebar','navigation.sidebar_right':'sidebar','navigation.refresh':'refresh','navigation.more_actions':'more','entry.kanban':'kanban','entry.automation':'automation','entry.new_chat':'new_chat','entry.new_project':'project','entry.chat':'new_chat','entry.project':'project','entry.website':'website','chat.send':'send','chat.stop':'stop','chat.attach':'attach','chat.expand':'expand','chat.collapse':'collapse','chat.voice':'voice','agent.default':'project','agent.terminal':'terminal','agent.database':'database','agent.library':'library','agent.folder':'project','agent.coder':'terminal','agent.kbase':'library' };
const bow = '<path d="M18 3q-5-5-6-1t6 3q5 5 6 1t-6-3" fill="#ef88b3" stroke="#a53368" stroke-width=".7"/><circle cx="18" cy="3" r="1.3" fill="#b83c72" stroke="none"/>';
for (const mode of ['light','dark']) {
  const images = {};
  const color = mode === 'light' ? '#814967' : '#f4bfd8';
  for (const [name, geometry] of Object.entries(paths)) {
    const canvas = createCanvas(96,96), ctx = canvas.getContext('2d');
    // Send is white on the primary button; stop keeps its danger semantics.
    const stroke = name === 'send' ? (mode === 'light' ? '#ffffff' : '#3b1730') : name === 'stop' ? '#d04475' : color;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="-2 -3 29 29"><g fill="none" stroke="${stroke}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${geometry}</g>${name==='send'||name==='stop' ? '' : bow}</svg>`;
    ctx.drawImage(await loadImage(Buffer.from(svg)),0,0);zip.file(`visuals/${mode}-${name}.png`,canvas.toBuffer('image/png'));
  }
  for (const [slot,name] of Object.entries(mapping)) images[slot]=`visuals/${mode}-${name}.png`;
  for (const [group,zh,en] of [['chats','对话','Chats'],['projects','项目','Projects'],['websites','站点','Sites']]) {
    for (const [locale,label] of [['zh-CN',zh],['en-US',en]]) {
      const canvas=createCanvas(360,100),ctx=canvas.getContext('2d');
      ctx.font='bold 62px "SkinHeading"';ctx.textBaseline='middle';ctx.lineWidth=6;ctx.strokeStyle=mode==='light'?'#fff6fa':'#402436';ctx.fillStyle=color;ctx.strokeText(label,12,52);ctx.fillText(label,12,52);
      const width=Math.min(360,Math.ceil(ctx.measureText(label).width+24));const cropped=createCanvas(width,100);cropped.getContext('2d').drawImage(canvas,0,0);
      const name=`visuals/${mode}-${group}-${locale}.png`;zip.file(name,cropped.toBuffer('image/png'));images[`heading.${group}.${locale}`]=name;
    }
  }
  manifest.variants[mode].visuals={images,styles:{unread:mode==='light'?'#c33170':'#ff98c7',unreadText:mode==='light'?'#ffffff':'#34182a',unreadShape:'heart',badgeShape:'round',headingStyle:'rounded'}};
}
zip.file('skin.json',JSON.stringify(manifest,null,2));
fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}));
console.log(output);
