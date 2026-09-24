import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { fetchUpdateManifest } = require('../dist-electron/main/modules/updates/download.js');
test('macOS manifests no longer require release notes', () => {
  const { parseUpdateManifest } = require('../dist-electron/main/modules/updates/manifest.js');
  const manifest = { schemaVersion: 1, productId: 'cutej', version: '0.4.14', publishedAt: new Date().toISOString(), artifacts: {} };
  assert.deepEqual(parseUpdateManifest(manifest, 'cutej', 'darwin').releaseNotes, {});
});
for (const platform of ['win32', 'darwin']) for (const query of ['source=dev', 'source=dev&platform=wrong&platform=other']) test(`shared feed routes ${platform} (${query}) and pins signatures to the redirected release`, async t => {
  const original = https.get, requests = [], headers = [];
  t.after(() => { https.get = original; });
  https.get = (url, options, callback) => {
    requests.push(String(url));
    headers.push(options.headers);
    const req = new EventEmitter(); req.setTimeout = () => {};
    queueMicrotask(() => {
      const first = requests.length === 1;
      const res = Readable.from([first ? '' : 'fixture']);
      res.statusCode = first ? 302 : 200;
      res.headers = first ? { location: `/releases/${platform}/12/desktop-latest.json` } : {};
      callback(res);
    });
    return req;
  };
  await fetchUpdateManifest(`https://example.com/api/updates/desktop-latest.json?${query}`, new AbortController().signal, platform);
  assert.equal(requests[0], `https://example.com/api/updates/desktop-latest.json?source=dev&platform=${platform}`);
  assert.deepEqual(requests.slice(1), [
    `https://example.com/releases/${platform}/12/desktop-latest.json`,
    ...(platform === 'win32' ? ['https://example.com/releases/win32/12/desktop-latest.json.sig'] : [])
  ]);
  for (const header of headers) assert.equal(header['X-Desktop-Platform'], undefined);
});

test('Windows signature request preserves platform when the shared entry returns a manifest directly', async t => {
  const original = https.get, requests = [];
  t.after(() => { https.get = original; });
  https.get = (url, options, callback) => {
    requests.push(String(url));
    const req = new EventEmitter(); req.setTimeout = () => {};
    queueMicrotask(() => {
      const res = Readable.from(['fixture']);
      res.statusCode = 200; res.headers = {};
      callback(res);
    });
    return req;
  };
  await fetchUpdateManifest('https://example.com/desktop-latest.json?source=dev', new AbortController().signal, 'win32');
  assert.deepEqual(requests, [
    'https://example.com/desktop-latest.json?source=dev&platform=win32',
    'https://example.com/desktop-latest.json.sig?source=dev&platform=win32'
  ]);
  await assert.rejects(fetchUpdateManifest('https://example.com/desktop-latest.json', new AbortController().signal, 'linux'), /Unsupported update platform/);
  assert.equal(requests.length, 2);
});
