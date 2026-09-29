import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, session, type Session } from "electron";
import { WEBAPP_AUTH_CHANNEL, type WebappAuthSessionResult } from "../../../shared/webapp-auth";
import { DESKTOP_BROWSER_WEBVIEW_PARTITION } from "../../../shared/browser-surfaces";
import { getDesktopStateRoot } from "../../infrastructure/filesystem/user-paths";
import { getDesktopSsoAccessToken, getDesktopSsoStatus, subscribeDesktopSsoCredentialRevocation } from "../identity";
import type { BrowserSurfaceRegistry } from "../web-surfaces";
import type { WebsFacade } from "./facade";
import { t } from "../../support/i18n/main-i18n";
import { parseSessionCookies, resolveSessionExchangeUrl, WebappAuthError } from "./auth-session-policy";

type CookieRecord = { partition: string; url: string; name: string };

export function registerWebappAuth(options: {
  registry: BrowserSurfaceRegistry;
  webs: WebsFacade;
  refreshToken(force?: boolean): Promise<string>;
}) {
  let epoch = 0;
  let cookies: CookieRecord[] = [];
  const busy = new Set<Session>();
  const controllers = new Set<AbortController>();
  const ledgerPath = () => path.join(getDesktopStateRoot(app), "web-auth-cookies.json");
  const persist = () => {
    const file = ledgerPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + ".tmp", JSON.stringify(cookies));
    fs.renameSync(file + ".tmp", file);
  };
  const clearCookies = async () => {
    // Keep failed records for retry; never erase unrelated session storage.
    for (const record of [...cookies]) {
      const target = record.partition ? session.fromPartition(record.partition) : session.defaultSession;
      await target.cookies.remove(record.url, record.name);
      await target.cookies.flushStore();
      cookies = cookies.filter(entry => entry !== record);
      persist();
    }
  };
  let cleanup = app.whenReady().then(async () => {
    if (fs.existsSync(ledgerPath())) {
      const saved: unknown = JSON.parse(fs.readFileSync(ledgerPath(), "utf8"));
      if (!Array.isArray(saved) || saved.length > 4096) throw new Error("Invalid auth cookie ledger");
      cookies = saved.filter((entry): entry is CookieRecord => {
        if (!entry || typeof entry !== "object" || !["", DESKTOP_BROWSER_WEBVIEW_PARTITION].includes(entry.partition) ||
            typeof entry.name !== "string" || !/^[!#$%&'*+\-.^_`|~\w]+$/u.test(entry.name)) return false;
        try { const u = new URL(entry.url); return ["https:", "http:"].includes(u.protocol) && u.href === u.origin + "/"; } catch { return false; }
      });
      await clearCookies();
    }
  });
  // Attach a rejection observer while retaining the rejected barrier (fail closed).
  void cleanup.catch(() => undefined);
  subscribeDesktopSsoCredentialRevocation(() => {
    epoch++;
    for (const controller of controllers) controller.abort();
    cleanup = cleanup.catch(() => undefined).then(clearCookies);
    void cleanup.catch(() => undefined);
  });
  ipcMain.handle(WEBAPP_AUTH_CHANNEL, async (event, input: unknown): Promise<WebappAuthSessionResult> => {
    const guest = event.sender;
    const frame = event.senderFrame;
    const controller = new AbortController();
    let locked = false;
    const changed = () => controller.abort();
    try {
      await cleanup;
      if (!frame || guest.isDestroyed() || frame !== guest.mainFrame) throw new WebappAuthError("forbidden", "Only the application top frame can sign in.");
      const initialUrl = frame.url;
      let surface = options.registry.resolveWebviewSurfaceTarget(guest.id);
      const detached = options.webs.webappWindowManager.resolveAuthGuest(guest);
      // Page bootstrap may precede host Surface registration. Wait only for a
      // real registration; never infer authority from a URL or client payload.
      if (!surface && !detached) surface = await options.registry.waitForWebviewSurfaceTarget(guest.id, 1500);
      if (guest.isDestroyed() || guest.mainFrame !== frame || frame.url !== initialUrl) {
        throw new WebappAuthError("context_changed", "The application page changed.");
      }
      const local = surface?.surfaceKind === "webapp" || Boolean(detached);
      if (!detached && surface?.surfaceKind !== "webapp" && surface?.surfaceKind !== "website") {
        throw new WebappAuthError("forbidden", "Authentication requires a registered Website or WebApp.");
      }
      const expectedSession = local ? session.fromPartition(DESKTOP_BROWSER_WEBVIEW_PARTITION) : session.defaultSession;
      if (guest.session !== expectedSession) throw new WebappAuthError("forbidden", "Unexpected application session.");
      const url = resolveSessionExchangeUrl(frame.url, input, local);
      const startEpoch = epoch;
      const originalUrl = frame.url;
      const validate = () => {
        const live = options.registry.resolveWebviewSurfaceTarget(guest.id);
        if (controller.signal.aborted || epoch !== startEpoch || guest.isDestroyed() || guest.mainFrame !== frame || frame.url !== originalUrl ||
            (detached ? options.webs.webappWindowManager.resolveAuthGuest(guest) !== detached :
              !live || live.registrationId !== surface?.registrationId || live.surfaceId !== surface?.surfaceId)) {
          throw new WebappAuthError("context_changed", "The page or Desktop account changed. Sign in again.");
        }
      };
      if (busy.has(guest.session)) throw new WebappAuthError("busy", "A sign-in is already in progress.");
      busy.add(guest.session); locked = true;
      controllers.add(controller);
      guest.on("did-start-navigation", changed);
      guest.once("destroyed", changed);
      const initialStatus = getDesktopSsoStatus(app);
      if (!initialStatus.authenticated || !initialStatus.user?.sub || !getDesktopSsoAccessToken()) {
        throw new WebappAuthError("sign_in_required", "Sign in to Desktop first.");
      }
      // Registration alone is not permission to disclose an SSO bearer. The native
      // prompt authorizes only this origin/path and this invocation, not future pages.
      const messageOptions: Electron.MessageBoxOptions = {
        type: "question", title: t("webAuth.title"), message: t("webAuth.message"),
        detail: url.href, buttons: [t("webAuth.cancel"), t("webAuth.allow")], defaultId: 0, cancelId: 0, noLink: true
      };
      const owner = BrowserWindow.fromWebContents(guest) || BrowserWindow.getFocusedWindow();
      const consent = owner ? await dialog.showMessageBox(owner, messageOptions) : await dialog.showMessageBox(messageOptions);
      validate();
      if (consent.response !== 1) throw new WebappAuthError("cancelled", "Sign-in was cancelled.");
      let token = await options.refreshToken();
      validate();
      const status = getDesktopSsoStatus(app);
      if (!token || !status.authenticated || !status.user?.sub) throw new WebappAuthError("sign_in_required", "Sign in to Desktop first.");
      const identity = JSON.stringify([status.user.issuer, status.user.sub]);
      const validateIdentity = () => {
        validate();
        const current = getDesktopSsoStatus(app);
        if (!current.authenticated || identity !== JSON.stringify([current.user?.issuer, current.user?.sub]) || !getDesktopSsoAccessToken()) {
          throw new WebappAuthError("context_changed", "The Desktop account changed.");
        }
      };
      // Isolated network session: no existing Cookie, service worker or automatic
      // Set-Cookie write into a live guest before the generation checks below.
      const transport = session.fromPartition("webapp-auth-exchange");
      const exchange = () => transport.fetch(url.href, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Origin: url.origin },
        body: "{}", credentials: "omit", redirect: "manual",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]), bypassCustomProtocolHandlers: true
      });
      let response = await exchange();
      if (response.status === 401) {
        await response.body?.cancel();
        token = await options.refreshToken(true);
        validateIdentity();
        if (!token) throw new WebappAuthError("sign_in_required", "Sign in to Desktop first.");
        response = await exchange();
      }
      validateIdentity();
      const lines = response.headers.getSetCookie();
      await response.body?.cancel();
      if (!response.ok) throw new WebappAuthError("exchange_rejected", `Session exchange returned HTTP ${response.status}.`);
      // Read expiry only from the trusted Identity provider's token; the website
      // independently verifies its signature, issuer, audience and permissions.
      const exp = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).exp;
      const details = parseSessionCookies(lines, url, typeof exp === "number" ? exp * 1000 : NaN);
      const partition = local ? DESKTOP_BROWSER_WEBVIEW_PARTITION : "";
      for (const detail of details) {
        const existing = await guest.session.cookies.get({ url: detail.url, name: detail.name });
        const managed = cookies.some(record => record.partition === partition && record.url === detail.url && record.name === detail.name);
        if (existing.length && !managed) throw new WebappAuthError("cookie_conflict", "The exchange would replace an unmanaged cookie. Use a dedicated session cookie name.");
      }
      validateIdentity();
      const records = details.map(detail => ({ partition, url: detail.url, name: detail.name }));
      cookies = cookies.filter(old => !records.some(record => JSON.stringify(old) === JSON.stringify(record))).concat(records);
      persist(); // Journal before writing, so restart can clean up interrupted writes.
      try {
        for (const detail of details) { validateIdentity(); await guest.session.cookies.set(detail); validateIdentity(); }
        await guest.session.cookies.flushStore();
        validateIdentity();
      } catch (error) {
        for (const record of records) await guest.session.cookies.remove(record.url, record.name);
        await guest.session.cookies.flushStore();
        throw error;
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof WebappAuthError ? { code: error.code, message: error.message } :
        { code: "exchange_failed", message: "Unable to establish a website session." } };
    } finally {
      if (locked) busy.delete(guest.session);
      controllers.delete(controller);
      guest.removeListener("did-start-navigation", changed);
      guest.removeListener("destroyed", changed);
    }
  });
}
