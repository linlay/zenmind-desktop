import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { APP_BRAND } = require("../dist-electron/shared/brand.js");
const { outputFiles } = await build({ stdin: { contents: `export { AgentIcon } from './src/renderer/app-shell/navigation/AgentIcon';`, resolveDir: process.cwd() }, bundle: true, write: false, platform: "node", format: "cjs", packages: "external", jsx: "automatic", loader: { ".css": "empty", ".svg": "text" }, define: { __DESKTOP_APP_BRAND__: JSON.stringify(APP_BRAND) } });
const mod = { exports: {} };
new Function("module", "exports", "require", outputFiles[0].text)(mod, mod.exports, require);
const render = props => renderToStaticMarkup(React.createElement(mod.exports.AgentIcon, props));

test("missing and legacy Agent icons resolve by mode to inline theme-colored SVG", () => {
  assert.match(render({}), /data-agent-icon-name="general"/);
  assert.match(render({ mode: "CODER", icon: "terminal" }), /data-agent-icon-name="coder"/);
  assert.match(render({ mode: "KBASE", icon: "library" }), /data-agent-icon-name="kbase"/);
  const colored = render({ icon: { name: "proxy", color: "#4370B4" }, size: 20 });
  assert.match(colored, /data-agent-icon-name="proxy"/);
  assert.match(colored, /color:#4370B4/);
  assert.match(colored, /width="20"/);
  assert.doesNotMatch(colored, /<img/);
});
test("explicit image URLs retain their image rendering in every Agent mode", () => {
  for (const mode of ["GENERAL", "CODER", "TEAM"]) {
    const html = render({ icon: "https://example.test/avatar.svg?revision=2", mode });
    assert.match(html, /<img/);
    assert.match(html, /src="https:\/\/example.test\/avatar.svg\?revision=2"/);
    assert.doesNotMatch(html, /data-agent-icon-name/);
  }
});
