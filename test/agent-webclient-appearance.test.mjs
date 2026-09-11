import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const { outputFiles } = await build({
  stdin: { contents: `export * from './src/shared/contracts/agent-webclient-bridge';
    export * from './src/preload/appearance-receiver';
    export * from './src/renderer/service-webview/appearanceHost';
    export * from './src/renderer/appearance/webclientProjection';
    export * from './src/shared/surface-identity';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: "browser", format: "esm"
});
const {
  parseAgentWebclientAppearanceSnapshot: parse,
  parseAgentWebclientAppearanceTokens: tokens,
  AGENT_WEBCLIENT_APPEARANCE_COLOR_TOKENS: colors,
  AGENT_WEBCLIENT_APPEARANCE_REQUEST_CHANNEL: requestChannel,
  AGENT_WEBCLIENT_APPEARANCE_SNAPSHOT_CHANNEL: snapshotChannel,
  createAppearanceReceiver, createWebclientAppearanceHost,
  isWebclientHostBackgroundSurface, createSurfaceIdentity, createServiceSurfaceIdentity
} = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);
const snapshot = (revision = 1, extra = {}) => ({
  schemaVersion: 1, revision, resolvedTheme: 'light', skinId: 'pack:0123456789abcdef0123456789abcdef',
  tokens: { '--accent': '#217854', '--control-radius': '12px' }, background: { mode: 'host' }, ...extra
});

test('appearance contract shares bounded ZIP visual tokens and rejects executable or unknown fields', () => {
  assert.ok(tokens(Object.fromEntries(colors.map(key => [key, 'rgba(1, 2, 3, 0.1234)']))));
  assert.ok(tokens({ '--control-radius': '32px', '--control-disabled-opacity': '.45' }));
  for (const value of [
    { '--accent': 'url(file:///private/file)' }, { '--accent': 'var(--private)' },
    { '--accent': 'rgb(256, 2, 3)' }, { '--accent': 'rgba(1, 2, 3, 2)' },
    { '--accent': '#fff\n' }, { '--accent-rgb': '1, 2, 3' },
    { '--control-radius': '33px' }, { '--control-radius': '50%' },
    { '--control-disabled-opacity': '1.1' }, { 'background-image': 'none' }
  ]) assert.equal(tokens(value), null);
  assert.deepEqual(parse(snapshot()), snapshot());
  for (const change of [
    { schemaVersion: 2 }, { revision: 0 }, { revision: 1.1 }, { revision: Number.MAX_SAFE_INTEGER + 1 },
    { resolvedTheme: 'system' }, { skinId: 'a'.repeat(97) }, { skinId: '../asset' },
    { background: { mode: 'host', path: '/private/file' } }, { background: { mode: 'image' } },
    { route: '/agent/unrelated' }, { tokens: null }
  ]) assert.equal(parse(snapshot(1, change)), null);
});

test('preload coalesces subscribe/read, ignores stale snapshots, and isolates listener failures', async () => {
  let requests = 0;
  const receiver = createAppearanceReceiver(() => requests++);
  receiver.refreshIfConsumed();
  assert.equal(requests, 0, 'a host probe does not make old pages consume the bridge');
  const received = [];
  receiver.bridge.subscribe(() => { throw new Error('consumer failed'); });
  const unsubscribe = receiver.bridge.subscribe(value => received.push(value));
  const read = receiver.bridge.getSnapshot();
  assert.equal(requests, 1);
  receiver.receive(snapshot(2));
  assert.deepEqual(await read, snapshot(2));
  receiver.receive(snapshot(1, { resolvedTheme: 'dark' }));
  receiver.receive(snapshot(2, { resolvedTheme: 'dark' }));
  receiver.receive(snapshot(3, { tokens: { '--accent': 'url(x)' } }));
  assert.equal(received.length, 1);
  const refreshed = receiver.bridge.getSnapshot();
  assert.equal(requests, 2);
  receiver.receive(snapshot(2));
  assert.deepEqual(await refreshed, snapshot(2));
  receiver.receive(null);
  assert.equal(received.at(-1), null);
  receiver.receive(snapshot(1));
  assert.equal(received.at(-1), null);
  receiver.receive(snapshot(2, { resolvedTheme: 'dark' }));
  assert.equal(received.at(-1), null);
  receiver.receive(snapshot(2));
  assert.deepEqual(received.at(-1), snapshot(2));
  unsubscribe();
  receiver.dispose();
});

test('preload timeout returns null and a valid later host snapshot recovers without reload', async () => {
  const receiver = createAppearanceReceiver(() => {}, 10);
  const received = [];
  receiver.bridge.subscribe(value => received.push(value));
  assert.equal(await receiver.bridge.getSnapshot(), null);
  assert.deepEqual(received, [null]);
  receiver.receive(snapshot(4));
  assert.deepEqual(received.at(-1), snapshot(4));
  const pending = receiver.bridge.getSnapshot();
  receiver.dispose();
  assert.equal(await pending, null);
});

function hostHarness() {
  const webview = new EventTarget();
  const sent = [], themes = [], backgrounds = [];
  let url = 'http://127.0.0.1:1234/agent/test', current = true, projection = snapshot();
  webview.getURL = () => url;
  webview.send = (channel, message) => sent.push({ channel, message });
  const host = createWebclientAppearanceHost({
    webview, isCurrentGuest: () => current, trustedUrl: () => 'http://127.0.0.1:1234/',
    read: () => { const { revision, ...result } = projection; return result; },
    onNegotiated: theme => themes.push(theme), onBackground: value => backgrounds.push(value)
  });
  const documentId = '12345678-1234-1234-1234-123456789abc';
  const request = (extra = {}) => webview.dispatchEvent(Object.assign(new Event('ipc-message'), {
    channel: requestChannel, args: [{ version: 1, documentId, origin: 'http://127.0.0.1:1234', ...extra }]
  }));
  return { webview, host, sent, themes, backgrounds, request, documentId,
    setProjection: next => { projection = next; }, setUrl: next => { url = next; }, invalidate: () => { current = false; } };
}

test('host waits for real bridge consumption and sends independent revisions without navigation', () => {
  const h = hostHarness();
  h.host.refresh();
  assert.equal(h.sent.filter(item => item.message?.snapshot).length, 0, 'old WebClient remains on its legacy theme path');
  h.request();
  h.sent.splice(0, h.sent.findIndex(item => item.message?.snapshot));
  assert.deepEqual(h.themes, ['light']);
  assert.equal(h.sent[0].channel, snapshotChannel);
  assert.equal(h.sent[0].message.documentId, h.documentId);
  assert.equal(h.sent[0].message.snapshot.revision, 1);
  h.host.refresh();
  assert.equal(h.sent.at(-1).message.snapshot.revision, 1);
  h.setProjection(snapshot(1, { resolvedTheme: 'dark' }));
  h.host.refresh();
  assert.equal(h.sent.at(-1).message.snapshot.revision, 2);
  assert.deepEqual(h.themes, ['light'], 'bootstrap URL theme is frozen after negotiation');
  h.setProjection(snapshot(1, { background: { mode: 'opaque' } }));
  h.host.refresh();
  assert.equal(h.backgrounds.at(-1), false);
  h.host.dispose();
  assert.equal(h.sent.at(-1).message.snapshot, null);
});

test('host rejects missing/forged origins, stale guests and non-Service URLs', () => {
  const h = hostHarness();
  h.sent.length = 0;
  h.request({ origin: undefined });
  h.request({ origin: 'http://example.com' });
  h.request({ documentId: '../invalid' });
  h.request({ version: 2 });
  assert.equal(h.sent.length, 0);
  h.setUrl('https://example.com/'); h.request();
  assert.equal(h.sent.length, 0);
  h.setUrl('http://127.0.0.1:1234/agent/test'); h.invalidate(); h.request();
  assert.equal(h.sent.length, 0);
  h.host.dispose();
});

test('document navigation revokes negotiation while in-place business navigation preserves it', () => {
  const h = hostHarness(); h.request();
  h.webview.dispatchEvent(Object.assign(new Event('did-start-navigation'), { isMainFrame: true, isInPlace: true }));
  assert.deepEqual(h.themes, ['light']);
  h.webview.dispatchEvent(Object.assign(new Event('did-start-navigation'), { isMainFrame: true, isInPlace: false }));
  assert.deepEqual(h.themes, ['light', null]);
  const count = h.sent.filter(item => item.message?.snapshot).length;
  h.host.refresh(); assert.equal(h.sent.filter(item => item.message?.snapshot).length, count);
  h.request({ documentId: 'aaaaaaaa-1234-1234-1234-123456789abc' });
  assert.equal(h.sent.at(-1).message.documentId, 'aaaaaaaa-1234-1234-1234-123456789abc');
  h.host.dispose();
});


test('wallpaper eligibility includes six management pages without expanding Chat or child surfaces', () => {
  const service = createServiceSurfaceIdentity('agent-webclient');
  const eligible = (surface, route, serviceId = 'agent-webclient') =>
    isWebclientHostBackgroundSurface(serviceId, surface, route);
  assert.equal(eligible(createSurfaceIdentity('main-chat'), '/agent/demo'), true);
  for (const path of ['/agents', '/skills', '/connectors', '/registries', '/archives', '/automations']) {
    for (const suffix of ['', '?tab=models', '/demo', '/demo?tab=source#editor']) {
      assert.equal(eligible(service, path + suffix), true, path + suffix);
    }
    assert.equal(eligible(service, path + '-other'), false);
  }
  for (const route of [undefined, '', '/', '/agent/demo', '/memory', '/project/demo']) {
    assert.equal(eligible(service, route), false, String(route));
  }
  for (const role of ['copilot-dock', 'kanban-chat', 'project', 'skill', 'agent', 'workpanel-web']) {
    assert.equal(eligible(createSurfaceIdentity(role, 'demo'), '/skills'), false, role);
  }
  assert.equal(eligible(service, '/skills', 'another-service'), false);
  assert.equal(eligible(createServiceSurfaceIdentity('another-service'), '/skills'), false);
});

test('management background changes refresh the existing relay without renegotiating or navigating', () => {
  const h = hostHarness();
  const surface = createServiceSurfaceIdentity('agent-webclient');
  const showRoute = route => {
    h.setProjection(snapshot(1, { background: {
      mode: isWebclientHostBackgroundSurface('agent-webclient', surface, route) ? 'host' : 'opaque'
    } }));
    h.host.refresh();
  };
  showRoute('/registries');
  h.request();
  assert.equal(h.backgrounds.at(-1), true);
  const firstRevision = h.sent.at(-1).message.snapshot.revision;
  showRoute('/memory');
  assert.equal(h.backgrounds.at(-1), false);
  showRoute('/skills/demo');
  assert.equal(h.backgrounds.at(-1), true);
  assert.equal(h.sent.at(-1).message.snapshot.revision, firstRevision + 2);
  assert.deepEqual(h.themes, ['light']);
  assert.equal(h.sent.at(-1).message.documentId, h.documentId);
  h.host.dispose();
});
