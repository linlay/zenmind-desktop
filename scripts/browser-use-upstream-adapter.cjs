// Apache-2.0 upstream: Microsoft Playwright, commit e8149b8257d32dcf8f72573ecc43e72439da7080.
// This adapter is appended inside the reviewed coreBundle lexical scope. It is private to Desktop's Worker.
module.exports.__desktopBrowserUse = {
  patchVersion: 1,
  async create(options) {
    // Inherited environment variables never authorize a connection. Main passes an
    // explicitly saved credential through the private Worker protocol when enabled.
    delete process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
    delete process.env.PWTEST_EXTENSION_USER_DATA_DIR;
    delete process.env.PWTEST_EXTENSION_PROTOCOL;
    delete process.env.PWTEST_EXTENSION_CONNECT_TIMEOUT;
    init_mcp();
    const config = await resolveConfig({
      browser: { browserName: "chromium", isolated: false, launchOptions: { headless: false } },
      capabilities: ["core", "vision"], webmcp: false, codegen: "none",
      outputDir: options.outputDir, timeouts: { action: 10000, navigation: 30000, settle: 300 },
      snapshot: { mode: "full" }, imageResponses: "allow"
    });
    // Only the isolated fixture factory supplies a launcher/profile; the production Worker never forwards these.
    const fixtureBrowser = options.extensionBrowser;
    if (options.extensionToken !== undefined && (typeof options.extensionToken !== "string" || !/^[A-Za-z0-9_-]{16,256}$/.test(options.extensionToken)))
      throw new Error("The saved Chrome authorization is invalid");
    let browser;
    try {
      if (options.extensionToken) process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = options.extensionToken;
      browser = options.context ? options.context.browser() : await createExtensionBrowser(
        "chrome", fixtureBrowser?.executablePath, fixtureBrowser?.userDataDir, options.profileDirName, options.clientName || "Desktop", options.signal
      );
    } finally {
      // The credential exists only for the upstream handshake inside this Worker.
      delete process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
    }
    const browserContext = options.context || browser.contexts()[0];
    if (!browserContext) throw new Error("Chrome did not provide an authorized page context");
    const backend = new BrowserBackend(config, browserContext, filteredTools(config));
    await backend.initialize({ cwd: options.outputDir, clientName: options.clientName || "Desktop" });
    const context = backend._context;
    // These hooks affect this private Context only. Downloads have one bounded host-owned consumer.
    context._desktopOnTab = tab => options.onTab?.(tab);
    context._desktopDownloadHandler = (tab, download) => options.onDownload?.(tab, download);
    await context.ensureBrowserContext();
    let closed = false;
    let queue = Promise.resolve();
    const metadata = new WeakMap();
    const fail = (code, message) => Object.assign(new Error(message), { code });
    const businessUrl = value => {
      try {
        const url = new URL(value);
        return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
      } catch { return false; }
    };
    const tabFor = (pageId) => {
      if (closed) throw fail("browser_disconnected", "Chrome connection is closed");
      const tab = context.tabs().find(t => t.desktopPageId === pageId);
      if (!tab || tab.page.isClosed() || tab.crashed || !businessUrl(tab.page.url()))
        throw fail("surface_not_found", "The selected Chrome business page is no longer available");
      return tab;
    };
    const enqueue = (operation) => {
      const result = queue.then(operation);
      queue = result.catch(() => {});
      return result;
    };
    const describe = async tab => {
      tabFor(tab.desktopPageId);
      const fallback = () => ({ pageId: tab.desktopPageId, url: tab.page.url().slice(0, 8192), title: '', active: false, isLoading: false, ...metadata.get(tab.page) });
      const modal = () => tab.modalStates().some(state => state.type === 'dialog' || state.type === 'fileChooser');
      if (modal()) return { ...fallback(), url: tab.page.url().slice(0, 8192) };
      let abandoned = false, resolveModal;
      const modalPromise = new Promise(resolve => { resolveModal = resolve; });
      const onModal = () => { abandoned = true; resolveModal({ ...fallback(), url: tab.page.url().slice(0, 8192) }); };
      tab.page.once('dialog', onModal); tab.page.once('filechooser', onModal);
      try {
        const read = async () => {
          const title = await tab.page.title().catch(() => '');
          if (abandoned || modal()) return fallback();
          tabFor(tab.desktopPageId);
          const visibility = await tab.page.evaluate(() => ({ active: document.visibilityState === 'visible', isLoading: document.readyState !== 'complete' })).catch(() => ({ active: false, isLoading: false }));
          if (abandoned || modal()) return fallback();
          tabFor(tab.desktopPageId);
          return { pageId: tab.desktopPageId, url: tab.page.url().slice(0, 8192), title: title.slice(0, 512), ...visibility };
        };
        const state = await Promise.race([read(), modalPromise]);
        tabFor(tab.desktopPageId);
        if (!abandoned && !modal()) metadata.set(tab.page, state);
        return state;
      } finally {
        abandoned = true;
        tab.page.off('dialog', onModal); tab.page.off('filechooser', onModal);
      }
    };
    return {
      browserContext,
      describe,
      async list() {
        if (closed) return [];
        // Connection/welcome pages may be present in the extension context. Never expose their metadata.
        const pages = await Promise.all(context.tabs().filter(t => !t.page.isClosed() && businessUrl(t.page.url())).map(async tab => {
          try { return await describe(tab); }
          catch (error) { if (error.code === 'surface_not_found') return null; throw error; }
        }));
        return pages.filter(Boolean);
      },
      async open(url) {
        return enqueue(async () => {
          if (closed) throw fail("browser_disconnected", "Chrome connection is closed");
          if (!businessUrl(url)) throw fail('url_not_allowed', 'Only HTTP and HTTPS business pages can be opened');
          let page;
          try { page = await browserContext.newPage(); }
          catch {
            if (closed || options.signal?.aborted) throw fail("cancelled", "Browser control has been released");
            throw fail("browser_page_creation_failed", "Chrome could not create or attach the new tab");
          }
          const tab = context.tabs().find(t => t.page === page);
          if (!tab) throw fail("browser_page_creation_failed", "Chrome could not attach the new tab");
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
          return describe(tab);
        });
      },
      async run(pageId, operation) {
        return enqueue(async () => {
          const tab = tabFor(pageId);
          context._desktopPinnedTab = tab;
          try {
            await tab.waitForInitialized();
            tabFor(pageId);
            if (!options.context && !tab.createDownloadSession) tab.createDownloadSession = async () => {
              tabFor(pageId);
              // chrome.debugger forbids an extra Browser or Page attachment.
              // Borrow only this authorized Page's existing transport, with an
              // exclusive Fetch response listener restored when this port closes.
              const serverPage = tab.page._connection.toImpl(tab.page);
              const parent = CRPage.mainFrameSession(serverPage)._client;
              if (serverPage.delegate._networkManager._protocolRequestInterceptionEnabled)
                throw fail('capability_unavailable', 'This page already has another network interception owner.');
              const previous = parent.listeners('Fetch.requestPaused');
              for (const listener of previous) parent.off('Fetch.requestPaused', listener);
              const listeners = new Set();
              let released = false;
              const receive = params => { for (const listener of listeners) listener(params); };
              parent.on('Fetch.requestPaused', receive);
              const methods = new Set(['Fetch.enable', 'Fetch.disable', 'Fetch.continueResponse', 'Fetch.getResponseBody']);
              const session = {
                send(method, params) {
                  if (released || !methods.has(method)) throw fail('capability_unavailable', 'This private response port is unavailable.');
                  if (!['Fetch.disable', 'Fetch.continueResponse'].includes(method)) tabFor(pageId);
                  return parent.send(method, params);
                },
                on(event, listener) { if (event !== 'Fetch.requestPaused') throw fail('capability_unavailable', 'This private session only observes paused responses.'); listeners.add(listener); return session; },
                off(event, listener) { listeners.delete(listener); return session; },
                async detach() {
                  if (released) return;
                  released = true; listeners.clear(); parent.off('Fetch.requestPaused', receive);
                  if (!tab.page.isClosed() && !parent._closed) for (const listener of previous)
                    if (!parent.listeners('Fetch.requestPaused').includes(listener)) parent.on('Fetch.requestPaused', listener);
                }
              };
              return session;
            };
            tabFor(pageId);
            const result = await operation(tab);
            // A successful close needs no live page. Other navigation must still be a business page
            // before any result, screenshot or snapshot leaves this private context.
            if (!tab.page.isClosed()) tabFor(pageId);
            return result;
          } finally {
            context._desktopPinnedTab = undefined;
          }
        });
      },
      async disconnect() {
        if (closed) return;
        closed = true;
        // Start transport close first: Context.dispose alone does not detach an extension connection.
        const disconnecting = options.context ? Promise.resolve() : browser.close().catch(() => {});
        await Promise.all([disconnecting, backend.dispose()]);
      }
    };
  }
};
