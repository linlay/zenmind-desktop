// Apache-2.0 upstream: Microsoft Playwright (playwright-core, stable releases).
// This adapter is appended to the installed coreBundle so it can reach the extension relay and the
// MCP backend classes. It does not replace any upstream source text: every Desktop behaviour is
// installed at runtime on Desktop's own objects, and missing upstream pieces fail with a clear error.
module.exports.__desktopBrowserUse = {
  patchVersion: 2,
  /**
   * Upstream bindings this adapter needs. The build checks the whole set; a connection checks the
   * part its path uses. Context methods are those Desktop wraps on its private Context instance.
   */
  missing(scope = "all") {
    const required = { init_mcp: typeof init_mcp, resolveConfig: typeof resolveConfig, BrowserBackend: typeof BrowserBackend, filteredTools: typeof filteredTools };
    if (scope !== "context") Object.assign(required, {
      CDPRelayServer: typeof CDPRelayServer, playwright: typeof playwright, defaultUserDataDirForChannel: typeof defaultUserDataDirForChannel,
    });
    if (scope === "all") {
      required.CRPage = typeof CRPage;
      const contextPrototype = typeof Context === "function" ? Context.prototype : undefined;
      for (const method of ["currentTab", "currentTabOrDie", "ensureTab", "_onPageCreated", "tabs", "ensureBrowserContext"])
        required[`Context.${method}`] = typeof contextPrototype?.[method] === "function" ? "function" : "undefined";
      required["Tab._downloadStarted"] = typeof Tab === "function" && typeof Tab.prototype._downloadStarted === "function" ? "function" : "undefined";
    }
    return Object.keys(required).filter(name => required[name] === "undefined");
  },
  // Desktop's own extension connection: the official relay and handshake, plus cancellation, and
  // without upstream's disk check that rejects a profile the discovery could not match.
  async connectExtension(executablePath, customUserDataDir, profileDirName, clientName, signal) {
    const fail = (code, message) => Object.assign(new Error(message), { code });
    const userDataDir = customUserDataDir ?? (executablePath ? void 0 : defaultUserDataDirForChannel("chrome"));
    let profileDirectory = profileDirName;
    if (profileDirectory === undefined && userDataDir && typeof findPlaywrightExtensionProfile === "function")
      profileDirectory = await findPlaywrightExtensionProfile(userDataDir).catch(() => undefined); // A profile hint only.
    if (signal?.aborted) throw fail("cancelled", "Browser connection cancelled");
    const relay = new CDPRelayServer("chrome", executablePath, customUserDataDir, profileDirectory);
    const abort = () => relay.stop();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await relay.start();
      if (signal?.aborted) throw fail("cancelled", "Browser connection cancelled");
      await relay.establishExtensionConnection(clientName);
      if (signal?.aborted) throw fail("cancelled", "Browser connection cancelled");
      const connected = await playwright.chromium.connectOverCDP(relay.cdpEndpoint(), { isLocal: true, timeout: 0, noDefaults: true });
      connected.on("disconnected", () => relay.stop());
      return connected;
    } catch (error) {
      relay.stop();
      throw signal?.aborted ? fail("cancelled", "Browser connection cancelled") : error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  },
  async create(options) {
    const missing = this.missing(options.context ? "context" : "extension");
    if (missing.length) throw Object.assign(new Error(`The installed Playwright release lacks ${missing.join(", ")}`), { code: "browser_runtime_unavailable" });
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
    const fail = (code, message) => Object.assign(new Error(message), { code });
    // Only the isolated fixture factory supplies a launcher/profile; the production Worker never forwards these.
    const fixtureBrowser = options.extensionBrowser;
    if (options.extensionToken !== undefined && (typeof options.extensionToken !== "string" || !/^[A-Za-z0-9_-]{16,256}$/.test(options.extensionToken)))
      throw new Error("The saved Chrome authorization is invalid");
    let browser;
    try {
      if (options.extensionToken) process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = options.extensionToken;
      browser = options.context ? options.context.browser() : await this.connectExtension(
        fixtureBrowser?.executablePath, fixtureBrowser?.userDataDir, options.profileDirName, options.clientName || "Desktop", options.signal
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
    if (typeof context?.tabs !== "function" || typeof context.ensureBrowserContext !== "function")
      throw fail("browser_runtime_unavailable", "The installed Playwright release lacks the expected browser context");
    // Every tab gets a pageId that is never reused, and the host-owned download handler. These
    // hooks are installed on this private Context and its tabs only.
    const adopt = tab => {
      if (!tab || tab.desktopPageId) return tab;
      tab.desktopPageId = require("crypto").randomUUID();
      // Downloads have one bounded host-owned consumer; upstream never saves them to its output directory.
      tab._downloadStarted = download => Promise.resolve(options.onDownload?.(tab, download));
      options.onTab?.(tab);
      return tab;
    };
    const onPageCreated = context._onPageCreated;
    if (typeof onPageCreated === "function") context._onPageCreated = function (page, ...rest) {
      const result = onPageCreated.call(this, page, ...rest);
      adopt(this.tabs().find(tab => tab.page === page));
      return result;
    };
    // While Desktop runs an operation, upstream tools act on exactly that pinned tab: no fallback to
    // the upstream current tab or a neighbouring page.
    let pinned;
    const pinnedTab = () => {
      if (!pinned || pinned.page.isClosed() || pinned.crashed || !context.tabs().includes(pinned))
        throw fail("surface_not_found", "The selected browser page is no longer available");
      return pinned;
    };
    // The build verifies these methods exist upstream; unit fixtures may supply a reduced Context.
    const currentTab = context.currentTab, currentTabOrDie = context.currentTabOrDie, ensureTab = context.ensureTab;
    if (typeof currentTab === "function") context.currentTab = function () { return pinned === undefined ? currentTab.call(this) : pinnedTab(); };
    if (typeof currentTabOrDie === "function") context.currentTabOrDie = function () { return pinned === undefined ? currentTabOrDie.call(this) : pinnedTab(); };
    if (typeof ensureTab === "function") context.ensureTab = async function (...args) {
      if (pinned === undefined) return ensureTab.apply(this, args);
      await this.ensureBrowserContext();
      const tab = pinnedTab();
      await tab.waitForInitialized();
      return pinnedTab();
    };
    await context.ensureBrowserContext();
    for (const tab of context.tabs()) adopt(tab);
    let closed = false;
    let queue = Promise.resolve();
    const metadata = new WeakMap();
    const businessUrl = value => {
      try {
        const url = new URL(value);
        return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
      } catch { return false; }
    };
    const tabFor = (pageId) => {
      if (closed) throw fail("browser_disconnected", "Chrome connection is closed");
      const tab = context.tabs().find(t => adopt(t).desktopPageId === pageId);
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
          try { return await describe(adopt(tab)); }
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
          const tab = adopt(context.tabs().find(t => t.page === page));
          if (!tab) throw fail("browser_page_creation_failed", "Chrome could not attach the new tab");
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
          return describe(tab);
        });
      },
      async run(pageId, operation) {
        return enqueue(async () => {
          const tab = tabFor(pageId);
          pinned = tab;
          try {
            await tab.waitForInitialized();
            tabFor(pageId);
            if (!options.context && !tab.createDownloadSession) tab.createDownloadSession = async () => {
              tabFor(pageId);
              // chrome.debugger forbids an extra Browser or Page attachment. Borrow only this
              // authorized Page's existing transport, with an exclusive Fetch response listener
              // restored when this port closes. These are Playwright internals: if a release
              // changes them, capture is unavailable and the browser keeps its native download.
              let serverPage, parent;
              try {
                serverPage = tab.page._connection.toImpl(tab.page);
                parent = CRPage.mainFrameSession(serverPage)._client;
              } catch { parent = undefined; }
              if (!parent || typeof parent.send !== 'function' || typeof parent.listeners !== 'function' || !serverPage?.delegate?._networkManager)
                throw fail('capability_unavailable', 'Download capture is unavailable with the installed Playwright release.');
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
            pinned = undefined;
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
