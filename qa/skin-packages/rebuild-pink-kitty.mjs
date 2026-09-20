// Rebuild only Pink Kitty; the existing archive is the authority for wallpaper and palette.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import JSZip from 'jszip';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { registerCollectionFonts, createCollectionArtwork } from './collection-artwork.mjs';
const root = path.resolve('output/skin-collection');
const target = path.join(root, 'pink-kitty.skin.zip');
const oldBytes = fs.readFileSync(target), oldZip = await JSZip.loadAsync(oldBytes);
const original = JSON.parse(await oldZip.file('skin.json').async('string'));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pink-kitty-rebuild-'));
fs.writeFileSync(path.join(temp, 'pink-kitty.previous.skin.zip'), oldBytes);
registerCollectionFonts(process.argv[2]);
const { manifest, files: generated } = await createCollectionArtwork(original, 'pink-kitty');
await build({ stdin: { resolveDir: process.cwd(), contents: `export * from './src/shared/desktop-skin-package';export * from './src/main/modules/settings/skin-package-archive';` }, bundle: true, platform: 'node', format: 'cjs', outfile: path.join(temp, 'validator.cjs') });
const api = createRequire(import.meta.url)(path.join(temp, 'validator.cjs'));
api.parseSkinPackageManifest(manifest);
const files = new Map();
for (const name of api.skinPackageResources(manifest)) {
  // Only the requested New Chat and eight localized headings change.
  const changed = /visuals\/(light|dark)-(new_chat|pinned-|chats-|projects-|websites-)/.test(name);
  files.set(name, changed ? generated.get(name) : await oldZip.file(name).async('nodebuffer'));
}
for (const mode of ['light', 'dark']) {
  assert.deepEqual(manifest.variants[mode].tokens, original.variants[mode].tokens);
  assert.deepEqual(manifest.variants[mode].background, original.variants[mode].background);
  for (const slot of ['chat.attach', 'chat.screenshot', 'navigation.refresh', 'entry.new_project']) assert(!(slot in manifest.variants[mode].visuals.images));
}
files.set('skin.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
const zip = new JSZip();
for (const [name, bytes] of files) zip.file(name, bytes, { createFolders: false, date: new Date('2026-01-01T00:00:00Z') });
const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
const staged = path.join(temp, 'pink-kitty.skin.zip');fs.writeFileSync(staged, bytes);
const parsed = await api.readSkinPackageArchive(staged);
for (const [name, bytes] of parsed.images) {
 const decodedPath = path.join(temp, name.replaceAll('/', '-'));fs.writeFileSync(decodedPath, bytes);
 const img = await loadImage(decodedPath).catch(e => { throw new Error(`${name}: ${e.message}`); });assert(img.width > 0 && img.height > 0, name);
 if (name.startsWith('visuals/')) assert(img.width <= 1024 && img.height <= 1024 && bytes.length <= 256 * 1024, name);
}
const source = path.join(root, 'sources/pink-kitty');
for (const [name, bytes] of files) fs.writeFileSync(path.join(source, name), bytes);
for (const mode of ['light','dark']) for (const name of ['attach','refresh']) fs.rmSync(path.join(source, `visuals/${mode}-${name}.png`), { force:true });
fs.writeFileSync(target + '.tmp', bytes);fs.renameSync(target + '.tmp', target);
// Keep the collection's existing preview and validation metadata in sync.
const previewPath = path.join(root, 'preview.html');
if (fs.existsSync(previewPath)) {
 let html = fs.readFileSync(previewPath, 'utf8');
 html = html.replace(/const skins=(.*);\nlet selected=/, (_, json) => {
  const skins = JSON.parse(json);const kitty = skins.find(s => s.key === 'pink-kitty');
  if (kitty) kitty.manifest = manifest;
  return 'const skins=' + JSON.stringify(skins).replaceAll('<', '\\u003c') + ';\nlet selected=';
 });
 const builder = fs.readFileSync(new URL('./build-themed-collection.mjs', import.meta.url), 'utf8');
 const imageLine = builder.split('\n').find(line => line.startsWith('const image=slot=>'));
 html = html.replace(/^const image=slot=>.*$/m, () => imageLine);
 fs.writeFileSync(previewPath, html);
}
const reportPath = path.join(root, 'validation.json');
if (fs.existsSync(reportPath)) {
 const report = JSON.parse(fs.readFileSync(reportPath));
 const entry = report.find(e => e.file === 'pink-kitty.skin.zip');
 if (entry) {
  Object.assign(entry, { version: manifest.version, bytes: bytes.length, zipEntries: files.size,
   visualFiles: [...files.keys()].filter(n => n.startsWith('visuals/')).length,
   slotsPerVariant: Object.keys(manifest.variants.light.visuals.images).length,
   visualBytes: [...files].filter(([n]) => n.startsWith('visuals/')).reduce((n,[,b]) => n+b.length,0),
   sha256: createHash('sha256').update(bytes).digest('hex'),
   validation: 'Canonical manifest + ZIP/CRC/resources + PNG decode; four native fallback slots; original wallpaper and palette preserved' });
  delete entry.electronRasterDecode;delete entry.browserImagesDecoded;
 }
 fs.writeFileSync(reportPath, JSON.stringify(report,null,2)+'\n');
}
// Side-by-side art sheet, including actual 16 px heading / icon sizes.
const canvas = createCanvas(1000, 630), ctx = canvas.getContext('2d');
for (const [index, mode] of ['light', 'dark'].entries()) {
 const x=index*500,v=manifest.variants[mode];ctx.fillStyle=v.tokens['--bg-base'];ctx.fillRect(x,0,500,630);
 ctx.fillStyle=v.tokens['--ink'];ctx.font='bold 24px CollectionSans';ctx.fillText(`Pink Kitty · ${mode} · 1.1.1`,x+28,42);
 for (const [row,group] of ['pinned','chats','projects','websites'].entries()) {
  const y=75+row*103;
  for (const [col,locale] of ['zh-CN','en-US'].entries()) {
   const img=await loadImage(files.get(v.visuals.images[`heading.${group}.${locale}`]));
   ctx.drawImage(img,x+28+col*195,y,img.width*.52,img.height*.52);
   ctx.drawImage(img,x+28+col*195,y+62,img.width*16/104,16);
  }
 }
 const icon=await loadImage(files.get(v.visuals.images['entry.new_chat']));
 ctx.drawImage(icon,x+28,507,48,48);ctx.drawImage(icon,x+100,525,16,16);
 ctx.font='16px CollectionSans';ctx.fillStyle=v.tokens['--ink'];ctx.fillText('New Chat',x+137,540);
 ctx.font='14px CollectionSans';ctx.fillText('Add content / Screenshot / Refresh / New project',x+28,587);
 ctx.fillText('使用应用原始图标',x+28,610);
}
fs.writeFileSync(path.join(root,'previews/pink-kitty-revision.png'),canvas.toBuffer('image/png'));
console.log(JSON.stringify({target,version:manifest.version,entries:files.size,slotsPerVariant:32,validation:'Canonical manifest + ZIP/CRC/resource validation + all PNG decode passed; four default slots absent; original wallpaper, palette and other icons preserved.',backup:path.join(temp,'pink-kitty.previous.skin.zip')},null,2));
