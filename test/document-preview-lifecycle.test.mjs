import test from "node:test";
import fs from "node:fs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { normalizeServiceLifecycleArgsConfig } = require("../dist-electron/main/modules/services/lifecycle-args.js");
for (const platform of ["darwin", "win32"]) {
  test(`preview origins survive lifecycle normalization on ${platform}`, () => {
    const deploy = ["--document-preview-api-base-url", "http://hub:8090", "--document-preview-public-base-url", "https://docs.example.test"];
    const config = normalizeServiceLifecycleArgsConfig({ services: { "agent-platform": { lifecycleArgs: { deploy } } } }, platform);
    assert.deepEqual(config.services["agent-platform"].lifecycleArgs.deploy, deploy);
  });
  test(`preview origins reject credentials, paths and YAML injection on ${platform}`, () => {
    for (const url of ["https://user:secret@docs.test", "https://docs.test/path", "https://docs.test?x=1", "https://docs.test#fragment", "https://docs.test\nother: true", "file:///tmp/a"]) {
      const config = normalizeServiceLifecycleArgsConfig({ services: { "agent-platform": { lifecycleArgs: { deploy: ["--document-preview-api-base-url", url] } } } }, platform);
      assert.deepEqual(config?.services["agent-platform"]?.lifecycleArgs.deploy ?? [], []);
    }
  });
}

test("brand preview origins survive Desktop initialization input normalization", () => {
  for (const [env, origin] of [["zenmind", "https://office.zenmind.cc"], ["cutej-dev", "https://document.qiuer.net"], ["cutej-prod", "https://document.gtjaqh.net"]]) {
    const source = new URL(`../../zenmind-env/env.${env}/desktop-init.json`, import.meta.url);
    // The adjacent environment repository is optional in standalone Desktop CI.
    if (!fs.existsSync(source)) continue;
    const input = JSON.parse(fs.readFileSync(source, "utf8"));
    for (const platform of ["darwin", "win32"]) {
      const config = normalizeServiceLifecycleArgsConfig(input, platform);
      const args = config.services["agent-platform"].lifecycleArgs.deploy;
      for (const flag of ["--document-preview-api-base-url", "--document-preview-public-base-url"]) {
        assert.equal(args[args.indexOf(flag) + 1], origin);
      }
    }
  }
});
