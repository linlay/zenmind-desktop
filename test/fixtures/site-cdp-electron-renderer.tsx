import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { ipcRenderer } from 'electron';
import { WebSurfaceHost, CanonicalWebappSurfaceHost } from '../../src/renderer/app-shell/embedded-surfaces/EmbeddedSurfaceHosts';
import { startDesktopActionRendererBridge } from '../../src/renderer/services/desktopActionRegistry';

const listen = (channel: string, callback: (value: any) => void) => {
  const listener = (_event: unknown, value: any) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.off(channel, listener);
};
(window as any).electronAPI = {
  embeddedCdp: {
    registerSurface: (input: unknown) => ipcRenderer.invoke('smoke.register', input),
    unregisterSurface: (input: unknown) => ipcRenderer.invoke('smoke.unregister', input),
    getSurfaceTargetState: () => Promise.resolve({ ok: false }),
  },
  onWebviewOpenTab: (listener: (value: any) => void) => listen('webview.openTab', listener),
  currentPage: { publishSnapshot: () => Promise.resolve({ ok: true }) },
  desktopActions: {
    onCall: (listener: (value: any) => void) => listen('desktopActions.call', listener),
    respond: (input: unknown) => ipcRenderer.invoke('smoke.response', input),
  },
  sso: { onStatusChanged: () => () => {} },
};
startDesktopActionRendererBridge();
const origin = new URLSearchParams(location.search).get('origin')!;
const items: any = new Map([
  ['website:a', { id: 'a', kind: 'website', label: 'A', url: origin + '/a' }],
  ['website:b', { id: 'b', kind: 'website', label: 'B', url: origin + '/b' }],
  ['webapp:app', { id: 'app', kind: 'webapp', label: 'App', url: origin + '/app', chrome: 'app' }],
]);
function Fixture() {
  const [active, setActive] = useState('website:a');
  const [owner, setOwner] = useState<any>({ scope: 'main-workspace' });
  const [opened, setOpened] = useState<any[]>([...items.keys()]);
  (window as any).smoke = { select: setActive, present: setOwner, close: (key: string) => setOpened((current) => current.filter((entry) => entry !== key)) };
  return <MemoryRouter><div className="app-content" style={{ position: 'relative', width: '100%', height: '100%' }}>
    <main className="app-main" style={{ position: 'relative', width: '100%', height: '100%' }}>
      <WebSurfaceHost activeEntryKey={active} itemMap={items} mountedEntryKeys={opened}
        onCloseWebItem={(key) => setOpened((current) => current.filter((entry) => entry !== key))} />
    </main>
    <div hidden={active !== 'workpanel'} data-work-panel-owner="chat-fixture" data-work-panel-item="app-item"
      style={{ position: 'absolute', inset: '10px', width: 650, height: 420 }} />
    <CanonicalWebappSurfaceHost activeEntryKey={active} itemMap={items} mountedEntryKeys={opened}
      presentations={opened.includes('webapp:app') ? { app: owner } : {}}
      workPanelState={{ workspaces: [{ ownerChatId: 'chat-fixture', activeItemId: 'app-item' }] }}
      activeWorkPanelChatId="chat-fixture" workPanelVisible={active === 'workpanel'}
      onCloseWebItem={(key) => setOpened((current) => current.filter((entry) => entry !== key))} />
  </div></MemoryRouter>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
