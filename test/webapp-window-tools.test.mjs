import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebappWindowTools } from '../dist-electron/main/modules/webs/webapps/window-tools.js';

for (const platform of ['darwin', 'win32']) {
  test(`WebApp window controls stay host-owned and restore geometry on ${platform}`, () => {
    const calls = []; let pinned = false, destroyed = false, fullscreen = false;
    const original = { x: 20, y: 30, width: 1180, height: 780 };
    const window = {
      isDestroyed: () => destroyed, isFullScreen: () => fullscreen, isMaximized: () => false,
      isAlwaysOnTop: () => pinned, setAlwaysOnTop: (v, level) => { pinned = v; calls.push(['top', v, level]); },
      getNormalBounds: () => original, getMinimumSize: () => [720, 480],
      setMinimumSize: (...value) => calls.push(['minimum', ...value]),
      setSize: (...value) => calls.push(['size', ...value]), setBounds: value => calls.push(['bounds', value])
    };
    const menu = createWebappWindowTools(window, platform);
    assert.deepEqual(menu(true).filter(item => item.role).map(item => item.role), ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']);
    menu(false).at(-2).click(); assert.equal(menu(false).at(-2).checked, true);
    assert.deepEqual(calls[0], ['top', true, platform === 'darwin' ? 'floating' : 'normal']);
    menu(false).at(-1).click(); assert.equal(menu(false).at(-1).checked, true);
    assert.deepEqual(calls.slice(-2), [['minimum', 340, 360], ['size', 420, 540]]);
    menu(false).at(-1).click(); assert.equal(menu(false).at(-1).checked, false);
    assert.deepEqual(calls.slice(-2), [['minimum', 720, 480], ['bounds', original]]);
    fullscreen = true; assert.equal(menu(false).at(-1).enabled, false);
    const count = calls.length; menu(false).at(-1).click(); assert.equal(calls.length, count);
    destroyed = true; menu(false).at(-2).click(); assert.equal(calls.length, count);
  });
}

const { EventEmitter } = await import('node:events');
const { attachWebappWindowCloseGuard } = await import('../dist-electron/main/modules/webs/webapps/window-tools.js');
test('close waits for guest unload, can be cancelled, and disposal bypasses the page', () => {
  const window = new EventEmitter(), contents = new EventEmitter();
  let bypass = false, destroyed = false, discard = false, requests = 0, shellCloses = 0;
  window.isDestroyed = () => false; window.close = () => shellCloses++;
  contents.isDestroyed = () => destroyed; contents.close = options => { assert.equal(options.waitForBeforeUnload, true); requests++; };
  attachWebappWindowCloseGuard(window, contents, () => bypass, () => discard);
  let prevented = 0;
  const event = { preventDefault() { prevented++; } };
  window.emit('close', event); window.emit('close', event); assert.equal(requests, 1);
  contents.emit('will-prevent-unload', event); assert.equal(prevented, 2);
  window.emit('close', event); assert.equal(requests, 2);
  discard = true; contents.emit('will-prevent-unload', event); assert.equal(prevented, 4);
  destroyed = true; contents.emit('destroyed'); assert.equal(shellCloses, 1);
  window.emit('close', event); assert.equal(prevented, 4);
  destroyed = false; bypass = true; window.emit('close', event); assert.equal(requests, 2);
});
