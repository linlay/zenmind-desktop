// Rebuild the actual skin collection using its source manifests and untouched wallpapers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import JSZip from 'jszip';
import { loadImage } from '@napi-rs/canvas';
import { registerCollectionFonts, createCollectionArtwork, COLLECTION_STYLES } from './collection-artwork.mjs';
const args = process.argv.slice(2);
const option = key => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1]; };
const root = path.resolve(option('--root') ?? 'output/skin-collection');
registerCollectionFonts(option('--font'));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'skin-collection-1.1-'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
await build({ stdin: { resolveDir: process.cwd(), contents: `export * from './src/shared/desktop-skin-package';export * from './src/shared/contracts/agent-webclient-bridge';export * from './src/main/modules/settings/skin-package-archive';export * from './src/main/modules/settings/appearance-images';` }, bundle: true, platform: 'node', format: 'cjs', outfile: path.join(temp, 'validator.cjs') });
const api = createRequire(import.meta.url)(path.join(temp, 'validator.cjs'));
const ready = [], validation = [];
for (const key of fs.readdirSync(path.join(root, 'sources')).filter(key => fs.existsSync(path.join(root, 'sources', key, 'skin.json')))) {
  const source = path.join(root, 'sources', key);
  const original = JSON.parse(fs.readFileSync(path.join(source, 'skin.json'), 'utf8'));
  const { manifest, files } = ['tahiti', 'gold-saints', 'wanyao-tulu-zhuan', 'xiaozhan', 'kenan', 'wangzhe-rongyao', 'world-of-warcraft', 'dunhuang', 'zhangjiajie'].includes(key)
    ? { manifest: original, files: new Map(Object.values(original.variants).flatMap(v => Object.values(v.visuals.images)).map(name => [name, fs.readFileSync(path.join(source, name))])) }
    : await createCollectionArtwork(original, key);
  for (const variant of Object.values(manifest.variants)) delete variant.visuals?.images['chat.screenshot'];
  const declared = new Set(api.skinPackageResources(manifest));
  for (const name of files.keys()) if (!declared.has(name)) files.delete(name);
  api.parseSkinPackageManifest(manifest);
  const backgroundBefore = hash(fs.readFileSync(path.join(source, original.variants.light.background.path)));
  const zip = new JSZip();
  const allFiles = new Map(files);
  for (const name of api.skinPackageResources(manifest)) {
    if (!allFiles.has(name)) allFiles.set(name, fs.readFileSync(path.join(source, name)));
  }
  allFiles.set('skin.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  for (const [name, data] of allFiles) zip.file(name, data, { createFolders: false, date: new Date('2026-01-01T00:00:00Z') });
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  const staged = path.join(temp, key + '.skin.zip');fs.writeFileSync(staged, bytes);
  const parsed = await api.readSkinPackageArchive(staged);
  assert.equal(parsed.manifest.schemaVersion, '1.1');
  let visualBytes = 0;
  for (const [name, data] of parsed.images) {
    const dimensions = api.inspectBackgroundImage(data);
    if (name.startsWith('visuals/')) {
      const decoded = await loadImage(data);
      assert.equal(decoded.width, dimensions.width); assert.equal(decoded.height, dimensions.height);
      visualBytes += data.length;
      assert(api.isSkinVisualDataUrl('data:image/png;base64,' + data.toString('base64')), name);
    }
  }
  assert(visualBytes <= api.SKIN_VISUAL_LIMITS.totalBytes);
  for (const mode of ['light', 'dark']) {
    assert.deepEqual(manifest.variants[mode].tokens, original.variants[mode].tokens);
    assert.deepEqual(manifest.variants[mode].background, original.variants[mode].background);
    const defaults = ['tahiti','gold-saints'].includes(key) ? ['chat.attach'] : key === 'pink-kitty' ? ['chat.attach', 'navigation.refresh', 'entry.new_project'] : [];
    assert.deepEqual(Object.keys(manifest.variants[mode].visuals.images).sort(), api.SKIN_VISUAL_SLOTS.filter(slot => ['xiaozhan', 'wangzhe-rongyao', 'kenan', 'world-of-warcraft', 'dunhuang', 'zhangjiajie'].includes(key) ? (slot.startsWith('heading.') || slot === 'chat.send') : !defaults.includes(slot)).sort());
  }
  assert.equal(hash(parsed.images.get(manifest.variants.light.background.path)), backgroundBefore);
  ready.push({ key, source, manifest, allFiles, bytes });
  validation.push({ file: key + '.skin.zip', name: manifest.name, schemaVersion: manifest.schemaVersion, version: manifest.version,
    bytes: bytes.length, zipEntries: Object.keys(zip.files).length, visualFiles: files.size, slotsPerVariant: Object.keys(manifest.variants.light.visuals.images).length,
    visualBytes, backgroundSha256: backgroundBefore, backgroundUnchanged: true, paletteUnchanged: true, sha256: hash(bytes),
    validation: 'canonical 1.1 manifest + ZIP path/CRC/limits + all PNG dimensions + visual PNG decode + full semantic slots passed' });
}
// Publish only after every skin passes. Existing packages are retained outside the output directory for recovery.
for (const item of ready) {
  const current = path.join(root, item.key + '.skin.zip');
  if (fs.existsSync(current)) fs.copyFileSync(current, path.join(temp, item.key + '.previous.zip'));
  for (const [name, bytes] of item.allFiles) {
    const destination = path.join(item.source, name);fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination + '.tmp', bytes);fs.renameSync(destination + '.tmp', destination);
  }
  fs.writeFileSync(current + '.tmp', item.bytes);fs.renameSync(current + '.tmp', current);
}
fs.writeFileSync(path.join(root, 'validation.json'), JSON.stringify(validation, null, 2) + '\n');
const data = ready.map(item => ({ key: item.key, manifest: item.manifest, style: COLLECTION_STYLES[item.key]?.label ?? item.manifest.name }));
const script = `const skins=${JSON.stringify(data).replaceAll('<', '\\u003c')};
let selected=0,mode='light';
const $=id=>document.getElementById(id);
function render(){const s=skins[selected],v=s.manifest.variants[mode],t=v.tokens;document.querySelectorAll('[data-skin]').forEach((b,i)=>b.classList.toggle('active',i===selected));
$('name').textContent=s.manifest.name;$('style').textContent=s.style+' · '+mode+' · '+Object.keys(s.manifest.variants[mode].visuals.images).length+' 个语义槽';$('download').href=s.key+'.skin.zip';
const stage=$('stage');stage.style.backgroundImage='url(sources/'+s.key+'/'+v.background.path+')';stage.style.color=t['--ink'];
$('side').style.background=t['--shell-sidebar-bg'];$('main').style.background=t['--shell-content-bg'];$('composer').style.background=t['--surface-strong'];
const image=slot=>v.visuals.images[slot]?'sources/'+s.key+'/'+v.visuals.images[slot]:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="'+t['--control-icon-color']+'" stroke-width="1.8" stroke-linecap="round"><path d="'+(slot==='chat.attach'?'M12 4v16M4 12h16':'M4 9V4h5m6 0h5v5M4 15v5h5m6 0h5v-5')+'"/></svg>');
document.querySelectorAll('[data-slot]').forEach(img=>{img.src=image(img.dataset.slot)});
document.querySelectorAll('[data-heading]').forEach(img=>img.src=image('heading.'+img.dataset.heading+'.zh-CN'));
$('send').style.background=t['--control-primary-bg'];$('send').querySelector('img').src=image('chat.send');$('stop').querySelector('img').src=image('chat.stop');
document.querySelectorAll('.badge,.dot').forEach(e=>{e.style.background=v.visuals.styles.unread;e.style.color=v.visuals.styles.unreadText;if(e.classList.contains('badge'))e.style.borderRadius=v.visuals.styles.badgeShape==='pill'?'6px':'99px'});
$('dot').style.clipPath=v.visuals.styles.unreadOutline?'polygon('+v.visuals.styles.unreadOutline.map(p=>p[0]+'% '+p[1]+'%').join(', ')+')':v.visuals.styles.unreadShape==='heart'?'polygon(50% 95%,5% 48%,0% 25%,12% 8%,30% 5%,50% 23%,70% 5%,88% 8%,100% 25%,95% 48%)':'none';
$('json').textContent=JSON.stringify(s.manifest,null,2);
$('tree').textContent=s.key+'.skin.zip\\n├── skin.json\\n├── assets/\\n│   └── background.png\\n└── visuals/\\n'+[...new Set(Object.values(s.manifest.variants.light.visuals.images).concat(Object.values(s.manifest.variants.dark.visuals.images)))].map((name,i,all)=>(i===all.length-1?'    └── ':'    ├── ')+name.split('/').pop()).join('\\n');
$('jsonlink').href='sources/'+s.key+'/skin.json';
}
$('tabs').innerHTML=skins.map((s,i)=>'<button data-skin="'+i+'">'+s.manifest.name+'</button>').join('');
$('tabs').onclick=e=>{if(e.target.dataset.skin!==undefined){selected=Number(e.target.dataset.skin);render()}};
$('theme').onclick=()=>{mode=mode==='light'?'dark':'light';render()};render();window.collectionPreview={select:(index,nextMode)=>{selected=index;mode=nextMode;render()}};`;
fs.writeFileSync(path.join(root, 'preview.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>皮肤集合 1.1</title><style>
*{box-sizing:border-box}body{margin:0;background:#f4f4f5;color:#28242a;font:15px system-ui}article{max-width:1160px;margin:auto;padding:30px}h1{font-size:28px;margin:0 0 8px}p{color:#68606a}button,a{font:inherit}button{cursor:pointer;padding:8px 13px;border:1px solid #ddd;border-radius:9px;background:white}.active{background:#28242a;color:white}#tabs{display:flex;gap:8px;flex-wrap:wrap;margin:22px 0}.bar{display:flex;align-items:center;gap:16px;margin:16px 0}.bar h2{margin:0;font-size:20px}.bar small{flex:1}#stage{height:650px;background-position:center;background-size:cover;display:flex;border:1px solid #ddd;border-radius:18px;overflow:hidden}#side{width:270px;padding:20px;backdrop-filter:blur(8px)}.tools{display:flex;gap:17px;margin:0 0 24px}.tools img,.row>img{width:22px;height:22px}.row{display:flex;gap:12px;align-items:center;margin:17px 0}.row span{flex:1}.heading{height:27px;width:auto;margin:15px 0 1px}.badge{min-width:21px;padding:2px 6px;border-radius:99px;font-size:12px;text-align:center}.dot{width:9px;height:9px;border-radius:50%}#main{flex:1;padding:32px;display:flex;flex-direction:column;justify-content:space-between}.hello{font-size:25px;text-align:center;font-weight:600;margin-top:20px}#composer{border-radius:18px;padding:20px;min-height:155px;border:1px solid #ffffff66}.draft{opacity:.75}.actions{display:flex;gap:12px;align-items:center;margin-top:46px}.actions img{width:24px;height:24px}.spacer{flex:1}#send,#stop{padding:7px;display:flex;align-items:center;justify-content:center;border-radius:10px;border:0;background:transparent}details{background:white;border:1px solid #ddd;border-radius:12px;margin-top:16px;padding:16px}summary{cursor:pointer;font-weight:600}pre{font:12px/1.6 ui-monospace,monospace;overflow:auto;max-height:650px;white-space:pre}a{color:#315cad}@media(max-width:720px){article{padding:16px}#side{width:220px}#main{padding:18px}.bar{flex-wrap:wrap}}
</style><article><h1>皮肤集合 · 1.1</h1><p>主题背景与配套功能图标、栏目艺术字和未读标记。点击主题与浅深色按钮预览。</p><nav id="tabs"></nav><div class="bar"><h2 id="name"></h2><small id="style"></small><button id="theme">切换浅色 / 深色</button><a id="download" download>下载 ZIP</a></div><div id="stage"><aside id="side"><div class="tools"><img data-slot="navigation.search"><img data-slot="navigation.sidebar_left"><img data-slot="navigation.back"><img data-slot="navigation.forward" style="opacity:.35"></div><div class="row"><img data-slot="entry.kanban"><span>看板</span></div><div class="row"><img data-slot="entry.automation"><span>自动化</span></div><div class="row"><img data-slot="entry.new_chat"><span>新建对话</span></div><img class="heading" data-heading="pinned"><div class="row"><span>常用对话</span></div><img class="heading" data-heading="chats"><div class="row"><span>新的创作灵感</span><i id="dot" class="dot"></i></div><img class="heading" data-heading="projects"><div class="row"><img data-slot="agent.terminal"><span>我的项目</span><b class="badge">12</b></div><div class="row"><img data-slot="agent.library"><span>知识文档</span><b class="badge">99+</b></div><img class="heading" data-heading="websites"></aside><section id="main"><div class="hello">与 小君 对话</div><div id="composer"><div class="draft">记录想法，开始新的对话……</div><div class="actions"><img data-slot="chat.attach"><div class="spacer"></div><button id="stop" aria-label="停止"><img></button><button id="send" aria-label="发送"><img></button></div></div></section></div><details><summary>查看 ZIP 内文件结构</summary><pre id="tree"></pre></details><details><summary>查看完整 skin.json</summary><p><a id="jsonlink">打开源 JSON 文件</a></p><pre id="json"></pre></details><p>这是静态外观预览。安装包已通过当前 1.1 校验器、图片解码与原始背景/配色一致性校验。真实业务交互由 Desktop / WebClient 组件负责。</p></article><script>${script}</script></html>`);
console.log(JSON.stringify({ output: root, skins: validation.map(v => ({ file: v.file, entries: v.zipEntries, visualFiles: v.visualFiles, slots: v.slotsPerVariant })), previousPackages: temp }, null, 2));
