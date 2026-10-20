import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { createElement } from "react";
import { createMemoryRouter, Route, Routes } from "react-router-dom";

const require = createRequire(import.meta.url);
const { renderToStaticMarkup } = require("react-dom/server");
const { StaticRouter } = require("react-router-dom/server");

const compiled = await build({
  entryPoints: [new URL("../src/shared/web-entry-routes.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs"
});
const module = { exports: {} };
new Function("module", "exports", compiled.outputFiles[0].text)(module, module.exports);
const { buildWebEntryPath, resolveWebRouteEntryKey } = module.exports;

const hosts = await build({
  entryPoints: [new URL("../src/renderer/app-shell/embedded-surfaces/EmbeddedSurfaceHosts.tsx", import.meta.url).pathname],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  packages: "external",
  plugins: [{
    name: "isolate-web-route-host",
    setup(builder) {
      builder.onResolve({ filter: /^\.{1,2}\// }, (args) => {
        if (args.path.endsWith("/web-entry-routes") || args.path === "./route-path") return;
        return { path: args.path, external: true };
      });
    }
  }]
});
const hostsModule = { exports: {} };
new Function("module", "exports", "require", hosts.outputFiles[0].text)(
  hostsModule,
  hostsModule.exports,
  (specifier) => {
    if (specifier.endsWith("/useI18n")) return { useI18n: () => ({ t: (key) => key }) };
    if (specifier.endsWith("/PlaceholderPage")) {
      return { PlaceholderPage: () => createElement("div", { "data-entry-missing": true }) };
    }
    return specifier.startsWith(".") ? {} : require(specifier);
  }
);
const { WebRouteFallback } = hostsModule.exports;

test("web entry routes preserve existing website and generated WebApp addresses", () => {
  for (const entryKey of ["website:docs", "website:my-site_1.2", "webapp:webapp-0123456789abcdef"]) {
    const route = `/webs/${entryKey}`;
    assert.equal(buildWebEntryPath(entryKey), route);
    assert.equal(resolveWebRouteEntryKey(route), entryKey);
    assert.equal(resolveWebRouteEntryKey(`${route}/`), entryKey);
  }
});

test("web entry routes round-trip local IDs through browser pathname encoding", () => {
  for (const id of ["My App", "大写 App #看板", "报告📚", "100%助手", "literal%2Fname", "literal%252Fname", "literal%23name"]) {
    const entryKey = `webapp:${id}`;
    const route = buildWebEntryPath(entryKey);
    const browserLocation = new URL(route, "http://desktop.local");
    assert.equal(browserLocation.search, "");
    assert.equal(browserLocation.hash, "");
    assert.equal(resolveWebRouteEntryKey(browserLocation.pathname), entryKey);
    assert.equal(buildWebEntryPath(resolveWebRouteEntryKey(browserLocation.pathname)), route);
  }
  assert.equal(buildWebEntryPath("webapp:My App #看板"), "/webs/webapp:My%20App%20%23%E7%9C%8B%E6%9D%BF");
  assert.equal(buildWebEntryPath("webapp:literal%2Fname"), "/webs/webapp:literal%252Fname");
});

test("web entry routes keep literal percent IDs distinct during router navigation and history", async (t) => {
  const entryKeys = ["webapp:literal%2Fname", "webapp:Literal #中文 App", "webapp:literal%252Fname"];
  const router = createMemoryRouter([{ path: "/webs/:entryKey" }], {
    initialEntries: [buildWebEntryPath(entryKeys[0])]
  });
  t.after(() => router.dispose());

  assert.equal(resolveWebRouteEntryKey(router.state.location.pathname), entryKeys[0]);
  for (const entryKey of entryKeys.slice(1)) {
    await router.navigate(buildWebEntryPath(entryKey));
    assert.equal(resolveWebRouteEntryKey(router.state.location.pathname), entryKey);
    assert.equal(router.state.location.search, "");
    assert.equal(router.state.location.hash, "");
  }
  await router.navigate(-1);
  assert.equal(resolveWebRouteEntryKey(router.state.location.pathname), entryKeys[1]);
  await router.navigate(-1);
  assert.equal(resolveWebRouteEntryKey(router.state.location.pathname), entryKeys[0]);
  await router.navigate(1);
  assert.equal(resolveWebRouteEntryKey(router.state.location.pathname), entryKeys[1]);
});

test("the rendered WebApp route resolves the exact installed entry despite router param decoding", () => {
  const entryKeys = ["webapp:literal%2Fname", "webapp:Literal #中文 App", "webapp:literal%252Fname"];
  const itemMap = new Map(entryKeys.map((entryKey) => [entryKey, { kind: "webapp", label: entryKey, url: "" }]));
  const renderRoute = (entryKey) => renderToStaticMarkup(createElement(
    StaticRouter,
    { location: buildWebEntryPath(entryKey) },
    createElement(Routes, null, createElement(Route, {
      path: "/webs/:entryKey",
      element: createElement(WebRouteFallback, { itemMap })
    }))
  ));
  for (const entryKey of entryKeys) assert.equal(renderRoute(entryKey), "");
  assert.match(renderRoute("webapp:missing"), /data-entry-missing/u);
});

test("web entry routes reject malformed encodings and identities containing path separators", () => {
  for (const pathname of [
    "/webs", "/webs/", "/webs/webapp:", "/webs/other:app", "/external/webapp:app",
    "/webs/webapp:bad%", "/webs/webapp:%E5%A", "/webs/webapp:bad%2Fname",
    "/webs/webapp:bad%5Cname", "/webs/webapp:app/child", "/webs/webapp:app?query=1", "/webs/webapp:app#hash"
  ]) {
    assert.equal(resolveWebRouteEntryKey(pathname), null, pathname);
  }
});
