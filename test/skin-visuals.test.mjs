import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const { outputFiles } = await build({ stdin: { contents: `export * from './src/shared/contracts/agent-webclient-bridge'; export * from './src/shared/desktop-skin-package'; export * from './src/preload/visuals-receiver'; export * from './src/renderer/service-webview/visualsHost';`, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'browser', format: 'esm' });
const api = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);
const { parseSkinPackageManifest, parseSkinVisuals, createVisualsReceiver, createVisualsHost,
  AGENT_WEBCLIENT_VISUALS_CHANNEL: channel, AGENT_WEBCLIENT_VISUAL_ASSET_CHANNEL: assetChannel } = api;
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=';
const resourceSet = '12345678-1234-1234-1234-123456789012';
const state = (revision = 1, extra = {}) => ({ schemaVersion: '1.1', revision, resourceSet, visuals: { images: { 'chat.send': 'chat.send' }, styles: { unread: '#c33170' } }, ...extra });

test('1.1 package accepts semantic PNG slots and rejects old versions, scripts and unknown styles', () => {
  const manifest = { schemaVersion: '1.1', id: 'bow', name: 'Bow', version: '1.1.0', variants: { light: { visuals: { images: { 'chat.send': 'assets/send.png', 'heading.pinned.zh-CN': 'assets/pinned-zh.png', 'heading.pinned.en-US': 'assets/pinned-en.png' }, styles: { unread: '#c33170', unreadShape: 'heart' } } }, dark: {} } };
  assert.equal(parseSkinPackageManifest(manifest).variants.light.visuals.images['chat.send'], 'assets/send.png');
  for (const schemaVersion of [1, 2, '1.0', '2.0']) assert.throws(() => parseSkinPackageManifest({ ...manifest, schemaVersion }));
  for (const visuals of [
    { images: { 'unknown.icon': 'a.png' } }, { images: { 'chat.send': '../a.png' } },
    { images: { 'chat.send': 'https://example.com/a.png' } }, { images: { 'chat.send': 'a.svg' } },
    { styles: { unread: 'transparent' } }, { styles: { unread: '#fff0' } },
    { styles: { css: 'display:none' } }, { styles: { unreadShape: 'star' } }
  ]) assert.throws(() => parseSkinPackageManifest({ ...manifest, variants: { light: { visuals }, dark: {} } }));
  assert.equal(parseSkinVisuals({ images: {} }, value => value)?.styles.headingStyle, undefined);
  const outline = [[0, 0], [100, 0], [50, 100]];
  const parsed = parseSkinVisuals({ styles: { unreadOutline: outline } }, value => value);
  assert.equal(api.skinVisualStyleVariables(parsed.styles)['--skin-unread-clip'], 'polygon(0% 0%, 100% 0%, 50% 100%)');
  outline[0][0] = 45;
  assert.equal(parsed.styles.unreadOutline[0][0], 0);
  for (const invalid of [[], [[0,0]], [[0,0],[100,0],[50,101]], [[0,0],[100,0],[NaN,0]], [[0,0],[100,0],['0',0]], Array(65).fill([0,0]), 'url(evil)']) {
    assert.equal(parseSkinVisuals({ styles: { unreadOutline: invalid } }, value => value), null);
  }
  assert.equal(parseSkinVisuals({ styles: { unreadShape: 'paw' } }, value => value), null);
});

test('preload deduplicates metadata reads and rejects stale, wrong-set and invalid PNG asset replies', async () => {
  let requests = 0, pending;
  const receiver = createVisualsReceiver(() => requests++, (resourceSet, slot, requestId) => { pending = { resourceSet, slot, requestId }; });
  const updates = [];
  receiver.bridge.subscribe(value => updates.push(value));
  const first = receiver.bridge.getSnapshot(); assert.equal(requests, 1);
  receiver.receive(state(2)); assert.deepEqual(await first, state(2));
  receiver.receive(state(1)); receiver.receive(state(2, { resourceSet: crypto.randomUUID() }));
  assert.equal(updates.length, 1);
  const asset = receiver.bridge.getAsset(resourceSet, 'chat.send'); receiver.receiveAsset({ ...pending, data: png }); assert.equal(await asset, png);
  const obsolete = receiver.bridge.getAsset(resourceSet, 'chat.send'); const oldRequest = pending;
  receiver.receive(state(3, { resourceSet: crypto.randomUUID() })); assert.equal(await obsolete, null);
  receiver.receiveAsset({ ...oldRequest, data: png });
  assert.equal(await receiver.bridge.getAsset(resourceSet, 'chat.send'), null);
  const current = updates.at(-1).resourceSet;
  const bad = receiver.bridge.getAsset(current, 'chat.send'); receiver.receiveAsset({ ...pending, data: 'data:image/svg+xml,<svg/>' }); assert.equal(await bad, null);
  receiver.dispose(); assert.equal(await receiver.bridge.getSnapshot(), null);
});

test('asset host never includes bytes in metadata and revokes resource access on skin changes or navigation', () => {
  const handlers = new Map(), sent = [];
  let current = true, revision = 0;
  let visuals = { images: { 'chat.send': png }, styles: {} };
  const guest = { addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener: name => handlers.delete(name), send: (name, payload) => sent.push({ name, ...payload }) };
  const host = createVisualsHost(guest, origin => current && (origin === undefined || origin === 'http://localhost:1234'), () => visuals, () => ++revision);
  const documentId = crypto.randomUUID();
  const request = (name, fields = {}) => handlers.get('ipc-message')({ channel: name, args: [{ version: '1.1', documentId, origin: 'http://localhost:1234', ...fields }] });
  request(channel, { origin: 'https://untrusted.example' }); assert.equal(sent.length, 0);
  request(channel); const first = sent.at(-1).snapshot; assert.equal(first.visuals.images['chat.send'], 'chat.send'); assert(!JSON.stringify(first).includes('base64'));
  request(assetChannel, { resourceSet: first.resourceSet, slot: 'chat.send', requestId: crypto.randomUUID() }); assert.equal(sent.at(-1).data, png);
  const count = sent.length;
  request(assetChannel, { documentId: crypto.randomUUID(), resourceSet: first.resourceSet, slot: 'chat.send', requestId: crypto.randomUUID() }); assert.equal(sent.length, count);
  visuals = { images: {}, styles: { unread: '#123456' } };
  request(assetChannel, { resourceSet: first.resourceSet, slot: 'chat.send', requestId: crypto.randomUUID() }); assert.equal(sent.at(-1).data, null);
  host.reset(); const resetCount = sent.length;
  request(assetChannel, { resourceSet: first.resourceSet, slot: 'chat.send', requestId: crypto.randomUUID() }); assert.equal(sent.length, resetCount);
  current = false; request(channel); assert.equal(sent.length, resetCount);
  host.dispose(); assert.equal(handlers.size, 0);
});


test('asset parser checks dimensions before allocating an image', () => {
  assert.equal(api.isSkinVisualDataUrl(png), true);
  const oversized = Buffer.from(png.slice(22), 'base64'); oversized.writeUInt32BE(1025, 16);
  assert.equal(api.isSkinVisualDataUrl('data:image/png;base64,' + oversized.toString('base64')), false);
  assert.equal(api.isSkinVisualDataUrl('data:image/png;base64,iVBORw0KGgo='), false);
});
