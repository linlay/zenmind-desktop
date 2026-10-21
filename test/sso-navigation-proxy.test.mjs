import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createDesktopSsoController } = require("../dist-electron/main/modules/identity/sso-controller.js");

function createController(platform, { proxyError } = {}) {
  const events = [];
  const controller = createDesktopSsoController({
    app: { getPath: () => "/unused-sso-navigation-test" },
    platform,
    session: {
      defaultSession: {
        async setProxy(config) {
          events.push({ kind: "proxy", config });
          if (proxyError) throw proxyError;
        }
      }
    },
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: {
        send(channel, input) { events.push({ kind: "dialog", channel, input }); }
      }
    }),
    async openBrowserUrl(input) {
      events.push({ kind: "browser", input });
      return { ok: true, action: "open", url: input.url, target: input.url, message: "" };
    },
    openExternal: async () => undefined
  });
  return { controller, events };
}

for (const platform of ["darwin", "win32"]) {
  for (const surface of ["openEmbeddedLoginDialog", "openBrowserUrl"]) {
    test(`${platform} ${surface} uses system proxy before navigating without changing the SSO URL or session`, async () => {
      const { controller, events } = createController(platform);
      const url = "https://sso.example.test/login?state=example-state";
      const result = await controller[surface]({ url, resolveRedirect: false });

      assert.equal(result.ok, true);
      assert.deepEqual(events[0], { kind: "proxy", config: { mode: "system" } });
      assert.equal(events.length, 2);
      assert.equal(events[1].input.url, url);
      assert.equal(events[1].input.partition, "");
      assert.match(events[1].input.userAgent, platform === "win32" ? /Windows NT/u : /Macintosh/u);
      if (surface === "openEmbeddedLoginDialog") {
        assert.equal(events[1].channel, "sso.embeddedLogin.open");
      }
    });

    test(`${platform} ${surface} does not open a guest when system proxy configuration fails`, async () => {
      const error = new Error("proxy setup unavailable");
      const { controller, events } = createController(platform, { proxyError: error });
      await assert.rejects(
        controller[surface]({ url: "https://sso.example.test/login", resolveRedirect: false }),
        (failure) => failure === error
      );
      assert.equal(events.length, 1);
      assert.equal(events[0].kind, "proxy");
    });
  }
}
