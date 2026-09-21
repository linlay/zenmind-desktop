import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { nextBrowserZoom, resolveWorkPanelBrowserShortcut } from '../dist-electron/shared/work-panel-browser.js';
import { workPanelDialogTools } from '../dist-electron/main/modules/work-panel/web-dialog-tools.js';

test('browser shortcuts explicitly distinguish macOS and Windows modifiers', () => {
  for (const [platform, correct, incorrect] of [['darwin', 'meta', 'control'], ['win32', 'control', 'meta']]) {
    for (const [key, command] of [['f','find'],['p','print'],['+','zoom-in'],['=','zoom-in'],['-','zoom-out'],['0','zoom-reset']]) {
      assert.equal(resolveWorkPanelBrowserShortcut(platform, { type:'keyDown', key, [correct]:true }), command);
      assert.equal(resolveWorkPanelBrowserShortcut(platform, { key, [incorrect]:true }), null);
      assert.equal(resolveWorkPanelBrowserShortcut(platform, { type:'keyUp', key, [correct]:true }), null);
      assert.equal(resolveWorkPanelBrowserShortcut(platform, { key, [correct]:true, alt:true }), null);
    }
    assert.equal(resolveWorkPanelBrowserShortcut(platform, {key:'+', [correct]:true, shift:true}), 'zoom-in');
    assert.equal(resolveWorkPanelBrowserShortcut(platform, {key:'p', [correct]:true, shift:true}), null);
  }
});

test('zoom uses bounded browser steps, including nonstandard current scales', () => {
  assert.equal(nextBrowserZoom(100,1),110);
  assert.equal(nextBrowserZoom(100,-1),90);
  assert.equal(nextBrowserZoom(112,1),125);
  assert.equal(nextBrowserZoom(112,-1),110);
  assert.equal(nextBrowserZoom(300,1),300);
  assert.equal(nextBrowserZoom(25,-1),25);
});

test('trusted dialog browser script remains valid JavaScript after localization', () => {
  assert.doesNotThrow(() => new vm.Script(workPanelDialogTools()));
});
