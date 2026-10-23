import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider } from 'antd';
import { ipcRenderer } from 'electron';
import { BrowserUseControl } from '../../src/renderer/work-panel/BrowserUseControl';
import { BrowserControlSettings } from '../../src/renderer/pages/settings/BrowserControlSettings';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { RendererI18nContext } from '../../src/renderer/i18n/i18n-context';
import { createTranslator, type SupportedLocale } from '../../src/shared/i18n';
import { readDocumentAntAppearanceTheme } from '../../src/renderer/appearance/antdTheme';
import { BROWSER_USE_CHANNEL, BROWSER_USE_CHANGED } from '../../src/shared/browser-use';
import '../../src/renderer/styles/theme.css';
import '../../src/renderer/styles/base.css';
import '../../src/renderer/styles/app-shell.css';
import '../../src/renderer/pages/settings/SettingsPage.css';

(window as any).electronAPI = {
  browserUse: {
    control: (request: unknown) => ipcRenderer.invoke(BROWSER_USE_CHANNEL, request),
    onChanged: (listener: (state: unknown) => void) => {
      const receive = (_event: unknown, state: unknown) => listener(state);
      ipcRenderer.on(BROWSER_USE_CHANGED, receive);
      return () => ipcRenderer.off(BROWSER_USE_CHANGED, receive);
    },
    settings: (request: unknown) => ipcRenderer.invoke('fixture.browserSettings', request),
    onSettingsChanged: (listener: (state: unknown) => void) => {
      const receive = (_event: unknown, state: unknown) => listener(state);
      ipcRenderer.on('fixture.browserSettingsChanged', receive);
      return () => ipcRenderer.off('fixture.browserSettingsChanged', receive);
    },
  },
};

function Fixture() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<'light' | 'dark'>('light');
  const [locale, setLocale] = useState<SupportedLocale>('zh-CN');
  const [chatId, setChatId] = useState<string | null>('chat-a');
  (window as any).browserUseUiFixture = {
    setTheme(next: 'light' | 'dark') { document.documentElement.dataset.theme = next; setMode(next); },
    setLocale, setChatId, navigate,
  };
  return <RendererI18nContext.Provider value={{ locale, source: 'stored', t: createTranslator(locale), setLocale: async next => setLocale(next) }}>
    <ConfigProvider theme={readDocumentAntAppearanceTheme(mode)}>
      <div className="app-shell is-mac-platform" style={{ position: 'relative', height: '100%', background: 'var(--bg-base)', font: '14px -apple-system, BlinkMacSystemFont, sans-serif' }}>
        <div style={{ height: 48, borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', paddingLeft: 20 }}>
          <strong>小君</strong><span style={{ marginLeft: 16, color: 'var(--ink-muted)' }}>浏览器控制 · 隔离界面验收</span>
        </div>
        <Routes>
          <Route path="/settings/browser" element={<section className="settings-page" style={{ padding: 28 }}><div style={{ maxWidth: 800 }}><h1>{createTranslator(locale)('settings.browser.label')}</h1><BrowserControlSettings /></div></section>} />
          <Route path="*" element={<><div className="main-chat-header-actions"><BrowserUseControl chatId={chatId} /></div>
            <div style={{ padding: 32, color: 'var(--ink-soft)' }}>使用真实组件、主题与受控 IPC；浏览器连接使用测试替身。</div></>} />
        </Routes>
      </div>
    </ConfigProvider>
  </RendererI18nContext.Provider>;
}
createRoot(document.getElementById('root')!).render(<MemoryRouter><Fixture /></MemoryRouter>);
