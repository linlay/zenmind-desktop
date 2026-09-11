import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import JSZip from "jszip";

const {
  createEnterpriseChatSupportBundle,
  redactEnterpriseChatSupportText
} = await import("../dist-electron/main/modules/enterprise-chat/support-bundle.js");
const { getDataRoot } = await import("../dist-electron/main/infrastructure/filesystem/user-paths.js");

function fixtureApp(homePath) {
  return {
    getPath(name) {
      if (name === "home") return homePath;
      if (name === "appData") return path.join(homePath, "Library", "Application Support");
      throw new Error(`unexpected app path ${name}`);
    },
    getVersion() {
      return "9.8.7";
    }
  };
}

test("enterprise chat support bundle includes only redacted Desktop settings and logs", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-chat-support-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const app = fixtureApp(homePath);
  const dataRoot = getDataRoot(app, "darwin");
  const desktopConfigRoot = path.join(dataRoot, "config", "desktop");
  const desktopLogRoot = path.join(dataRoot, "logs", "desktop");
  const serviceConfigRoot = path.join(dataRoot, "config", "services", "identity-center");
  fs.mkdirSync(desktopConfigRoot, { recursive: true });
  fs.mkdirSync(desktopLogRoot, { recursive: true });
  fs.mkdirSync(serviceConfigRoot, { recursive: true });
  fs.writeFileSync(path.join(desktopConfigRoot, "sso.json"), JSON.stringify({
    baseUrl: "https://identity.example.test",
    clientSecret: "do-not-send",
    nested: { accessToken: "also-secret" },
    localPath: path.join(homePath, "private", "config.json")
  }));
  fs.writeFileSync(
    path.join(desktopLogRoot, "main.log"),
    `request Authorization=Bearer secret-token path=${path.join(dataRoot, "logs", "desktop")}\n`
  );
  fs.writeFileSync(path.join(serviceConfigRoot, ".env"), "ROOT_PASSWORD=service-owned\n");

  const result = await createEnterpriseChatSupportBundle(app, "darwin");
  assert.match(result.filename, /^desktop-support-.*\.zip$/u);
  const zip = await JSZip.loadAsync(result.bytes);
  const names = Object.keys(zip.files);
  assert.equal(names.includes("config/desktop/sso.json"), true);
  assert.equal(names.includes("logs/desktop/main.log"), true);
  assert.equal(names.some((name) => name.includes("services/identity-center")), false);

  const config = await zip.file("config/desktop/sso.json").async("string");
  assert.match(config, /identity\.example\.test/u);
  assert.doesNotMatch(config, /do-not-send|also-secret/u);
  assert.match(config, /\[REDACTED\]/u);
  assert.match(config, /\$HOME\/private/u);

  const log = await zip.file("logs/desktop/main.log").async("string");
  assert.doesNotMatch(log, /secret-token|\.zenmind\/\.desktop/u);
  assert.match(log, /Authorization=\[REDACTED\]/u);
  assert.match(log, /\$DESKTOP_DATA/u);

  const manifest = JSON.parse(await zip.file("manifest.json").async("string"));
  assert.equal(manifest.appVersion, "9.8.7");
  assert.deepEqual(manifest.scope, ["config/desktop", "logs/desktop"]);
});

test("enterprise chat support redaction removes JWTs and URL credentials", () => {
  const redacted = redactEnterpriseChatSupportText(
    "GET https://example.test/?token=url-secret Authorization: Bearer eyJheader123.payload123.signature123",
    "/Users/demo",
    "/Users/demo/.zenmind/.desktop"
  );
  assert.doesNotMatch(redacted, /url-secret|eyJheader123/u);
  assert.match(redacted, /\[REDACTED\]/u);
});
