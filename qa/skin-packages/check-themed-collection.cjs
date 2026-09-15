const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const root = path.resolve(process.env.SKIN_COLLECTION_ROOT || 'output/skin-collection');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'skin-collection-qa-'));
app.setPath('userData', temporary);
let win;
app.whenReady().then(async () => {
  const report = JSON.parse(fs.readFileSync(path.join(root, 'validation.json')));
  for (const entry of report) {
    const zip = await JSZip.loadAsync(fs.readFileSync(path.join(root, entry.file)));
    for (const file of Object.values(zip.files).filter(file => file.name.endsWith('.png'))) {
      const decoded = nativeImage.createFromBuffer(await file.async('nodebuffer'));
      assert(!decoded.isEmpty(), entry.file + ': ' + file.name);
    }
    entry.electronRasterDecode = true;
  }
  win = new BrowserWindow({ show: false, width: 1160, height: 1050, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  await win.loadFile(path.join(root, 'preview.html'));
  const screenshots = path.join(root, 'previews');fs.mkdirSync(screenshots, { recursive: true });
  for (let i = 0; i < report.length; i++) {
    for (const mode of ['light', 'dark']) {
      await win.webContents.executeJavaScript(`collectionPreview.select(${i},${JSON.stringify(mode)})`);
      await win.webContents.executeJavaScript(`Promise.all([...document.images].map(img => img.decode())).then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))`);
      const screenshot = report[i].file.replace('.skin.zip', '') + '-' + mode + '.png';
      fs.writeFileSync(path.join(screenshots, screenshot), (await win.webContents.capturePage()).toPNG());
    }
    report[i].browserImagesDecoded = true;
  }
  fs.writeFileSync(path.join(root, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('PASS: all five archives decode in Electron; ten light/dark previews rendered.');
}).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  if (win && !win.isDestroyed()) win.destroy();
  fs.rmSync(temporary, { recursive: true, force: true });app.exit(process.exitCode || 0);
});
