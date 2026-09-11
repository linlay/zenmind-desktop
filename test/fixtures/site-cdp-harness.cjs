const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createBrowserSurfaceRegistry } = require('../../dist-electron/main/modules/web-surfaces/browser-surface-registry.js');
const { createWebEntrySurfaceIdentity } = require('../../dist-electron/shared/surface-identity.js');
const { captureCopilotSiteCdpScope } = require('../../dist-electron/main/modules/web-surfaces/cdp/site-scope.js');

function createSiteHarness() {
  const contents = new Map();
  const registrations = new Map();
  let snapshot = null;
  let nextId = 100;
  const entries = [];
  const commands = [];
  const registry = createBrowserSurfaceRegistry({
    webContents: { fromId: (id) => contents.get(id), getAllWebContents: () => [...contents.values()] },
    listWebEntries: () => ({ items: entries }),
    getCurrentPageSnapshot: () => snapshot,
  });
  function guest(url, previousThrottle = true) {
    const value = new EventEmitter();
    let attached = false;
    Object.assign(value, {
      id: ++nextId, destroyed: false, url, throttle: previousThrottle, throttleChanges: [],
      isDestroyed() { return this.destroyed; }, getType: () => 'webview',
      getURL() { return this.url; }, getTitle: () => 'Page',
      getBackgroundThrottling() { return this.throttle; },
      setBackgroundThrottling(value) { this.throttle = value; this.throttleChanges.push(value); },
      reload() { commands.push({ id: this.id, method: 'Page.reload' }); },
      debugger: {
        isAttached: () => attached, attach: () => { attached = true; }, detach: () => { attached = false; },
        sendCommand: async (method, params) => { commands.push({ id: value.id, method, params }); return { value: value.id }; },
      },
    });
    contents.set(value.id, value);
    return value;
  }
  function tab(value) {
    return { tabId: `tab-${value.id}`, webContentsId: value.id, currentUrl: value.url, title: 'Page', canGoBack: false, canGoForward: false, isLoading: false };
  }
  function register(value) {
    registrations.set(value.surfaceId, value);
    assert.deepEqual(registry.registerSurfaceResult(value, 7), { ok: true });
  }
  function foreground(value) {
    const activeTab = value.tabs.find((tab) => tab.tabId === value.activeTabId);
    snapshot = { pageKind: 'webview', surfaceId: value.surfaceId, webContentsId: activeTab?.webContentsId, route: value.pageRoute };
    for (const current of registrations.values()) {
      current.active = current.surfaceId === value.surfaceId;
      register(current);
    }
  }
  function site(name, kind = 'website') {
    const entryKey = `${kind}:${name}`;
    const url = kind === 'website' ? `https://${name}.example/` : 'http://127.0.0.1:19001/';
    entries.push({ id: name, entryKey, kind, label: name, url });
    const value = guest(url);
    const registration = {
      ...createWebEntrySurfaceIdentity(kind, entryKey), registrationId: `registration-${name}`,
      surfaceIdentityKey: entryKey, surfaceKind: kind, pageRoute: `/webs/${entryKey}`,
      label: name, url, active: false, tabs: [tab(value)], activeTabId: `tab-${value.id}`,
    };
    register(registration);
    return registration;
  }
  function capture(value) {
    foreground(value);
    return captureCopilotSiteCdpScope(registry, {
      surfaceRole: 'copilot-dock', active: true, parentSurfaceId: value.surfaceId,
      surfaceIdentityKey: value.surfaceIdentityKey, ownerWebContentsId: 7,
    });
  }
  function addTab(value) {
    const added = tab(guest(`${value.url}popup-${nextId}`));
    value.tabs = [...value.tabs, added]; value.activeTabId = added.tabId;
    register(value);
    return added;
  }
  function closeTab(value, tabId) {
    const closed = value.tabs.find((tab) => tab.tabId === tabId);
    value.tabs = value.tabs.filter((tab) => tab.tabId !== tabId);
    value.activeTabId = value.tabs.at(-1)?.tabId ?? null;
    if (value.tabs.length) register(value);
    else { registry.unregisterSurface(value, 7); registrations.delete(value.surfaceId); }
    if (closed) { const target = contents.get(closed.webContentsId); target.destroyed = true; target.emit('destroyed'); }
  }
  return { registry, contents, registrations, commands, site, guest, tab, register, foreground, capture, addTab, closeTab };
}
module.exports = { createSiteHarness };
