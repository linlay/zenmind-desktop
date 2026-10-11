import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { prepareDarwinDevElectronApp } from "../scripts/platform/dev-darwin.mjs";
import { brandIconDir } from "../scripts/lib/brand-config.mjs";

const darwinOnly = { skip: process.platform !== "darwin" };
const launchEnvironmentKeys = [
  "BRAND", "DESKTOP_BRAND_JSON", "DESKTOP_BUILTIN_ASSETS_ROOT", "DESKTOP_DEV_RESOURCES_ROOT",
  "DESKTOP_NODE_BIN", "MallocNanoZone", "PATH", "VITE_DEV_SERVER_URL"
].sort();

function readPlist(filePath) {
  return JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", filePath], {
    encoding: "utf8", timeout: 10000
  }));
}

function bundleFiles(root) {
  const files = {};
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filePath);
      else files[path.relative(root, filePath)] = {
        hash: createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"),
        mode: fs.statSync(filePath).mode
      };
    }
  };
  visit(root);
  return files;
}

function fixture(t) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-dev-document-"));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const root = path.join(temporaryRoot, 'project 中文 "quotes"');
  const brand = { id: "cutej", productName: "CuteJ", appId: "cc.cutej.desktop", packageName: "desktop" };
  const contents = path.join(root, "Electron.app", "Contents");
  const main = path.join(contents, "MacOS", "Electron");
  const helperContents = path.join(contents, "Frameworks", "Electron Helper.app", "Contents");
  fs.mkdirSync(path.dirname(main), { recursive: true });
  fs.writeFileSync(main, "fixture", { mode: 0o755 });
  fs.mkdirSync(path.join(helperContents, "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(helperContents, "MacOS", "Electron Helper"), "fixture", { mode: 0o755 });
  fs.writeFileSync(path.join(helperContents, "Info.plist"), '<plist version="1.0"><dict><key>LSUIElement</key><true/></dict></plist>');
  fs.writeFileSync(path.join(contents, "Info.plist"), '<plist version="1.0"><dict><key>LSEnvironment</key><dict><key>PATH</key><string>/old/session/bin</string></dict></dict></plist>');
  fs.writeFileSync(path.join(root, "VERSION"), "v0.4.32\n");
  const icons = brandIconDir(root, brand);
  fs.mkdirSync(icons, { recursive: true });
  for (const name of ["icon.icns", "icon.png"]) fs.writeFileSync(path.join(icons, name), "fixture icon");
  const electronModule = path.join(root, "node_modules", "electron");
  fs.mkdirSync(electronModule, { recursive: true });
  fs.writeFileSync(path.join(electronModule, "index.js"), [
    'let appPath = "fixture Resources/app";',
    "exports.app = { setAppPath: value => { appPath = value; }, getAppPath: () => appPath };",
    ""
  ].join("\n"));
  const projectMain = path.join(root, "dist-electron", "main", "index.js");
  fs.mkdirSync(path.dirname(projectMain), { recursive: true });
  fs.writeFileSync(projectMain, `process.stdout.write(JSON.stringify({
    marker: "project main evaluated", filename: __filename, cwd: process.cwd(), argv: process.argv,
    appPath: require("electron").app.getAppPath(),
    environment: Object.fromEntries(${JSON.stringify(launchEnvironmentKeys)}.map(key => [key, process.env[key]]))
  }));\n`);
  const signingInputs = [];
  const signApp = (appRoot) => {
    assert.ok(appRoot.startsWith(`${root}${path.sep}`));
    assert.ok(fs.existsSync(path.join(appRoot, "Contents", "Resources", "app", "index.cjs")));
    signingInputs.push(bundleFiles(appRoot));
  };
  const prepare = () => prepareDarwinDevElectronApp(main, root, brand, signApp);
  return { temporaryRoot, root, brand, main, projectMain, prepare, signingInputs };
}

function withLaunchEnvironment(values, run) {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function runBootstrap(input, preparedApp, args = []) {
  const entryRoot = path.join(preparedApp.appRoot, "Contents", "Resources", "app");
  const manifest = JSON.parse(fs.readFileSync(path.join(entryRoot, "package.json"), "utf8"));
  const entry = path.join(entryRoot, manifest.main);
  const result = spawnSync(process.execPath, ["--eval", [
    `process.argv = ${JSON.stringify([preparedApp.binaryPath, ...args])};`,
    `require(${JSON.stringify(entry)});`
  ].join("\n")], {
    cwd: input.temporaryRoot,
    env: { PATH: "/usr/bin:/bin", BRAND: "unrelated", __CFBundleIdentifier: preparedApp.bundleId },
    encoding: "utf8", timeout: 10000
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("macOS dev bundle advertises all Markdown and HTML suffixes before signing", darwinOnly, (t) => {
  const input = fixture(t);
  const preparedApp = input.prepare();
  const info = readPlist(path.join(preparedApp.appRoot, "Contents", "Info.plist"));
  assert.deepEqual(info.CFBundleDocumentTypes.flatMap((item) => item.CFBundleTypeExtensions), ["md", "markdown", "html", "htm"]);
  for (const documentType of info.CFBundleDocumentTypes) {
    assert.equal(documentType.CFBundleTypeRole, "Viewer");
    assert.equal(documentType.LSHandlerRank, "Alternate");
    assert.equal(documentType.CFBundleTypeIconFile, info.CFBundleIconFile);
  }
  assert.equal(info.CFBundleIdentifier, "cc.cutej.desktop.dev");
  assert.equal(Object.hasOwn(info, "LSEnvironment"), false);
  assert.deepEqual(input.signingInputs, [bundleFiles(preparedApp.appRoot)]);
});

test("macOS dev environment manifest is outside the bundle and includes only allowed launch values", darwinOnly, (t) => {
  const input = fixture(t);
  const preparedApp = withLaunchEnvironment({
    PATH: "/test runtime/bin:/usr/bin", DESKTOP_NODE_BIN: "/test runtime/bin/node",
    MallocNanoZone: "1", DESKTOP_BOOTSTRAP_TEST_SECRET: "fixture secret must not be persisted"
  }, input.prepare);
  const environmentPath = path.join(path.dirname(preparedApp.appRoot), "launch-environment.json");
  assert.ok(path.relative(preparedApp.appRoot, environmentPath).startsWith(`..${path.sep}`));
  const environment = JSON.parse(fs.readFileSync(environmentPath, "utf8"));
  assert.deepEqual(Object.keys(environment).sort(), launchEnvironmentKeys);
  assert.deepEqual(environment, {
    MallocNanoZone: "1", PATH: "/test runtime/bin:/usr/bin", BRAND: input.brand.id,
    DESKTOP_BRAND_JSON: path.join(input.root, "build", "brands", input.brand.id, "generated", "brand.json"),
    DESKTOP_BUILTIN_ASSETS_ROOT: path.join(input.root, "build", "resources", "services"),
    DESKTOP_DEV_RESOURCES_ROOT: path.join(input.root, "build", "brands", input.brand.id, "resources"),
    DESKTOP_NODE_BIN: "/test runtime/bin/node", VITE_DEV_SERVER_URL: "http://127.0.0.1:5173"
  });
  assert.equal(fs.readFileSync(environmentPath, "utf8").includes("fixture secret"), false);
  assert.equal(Object.keys(bundleFiles(preparedApp.appRoot)).some((name) => name.endsWith("launch-environment.json")), false);
});

test("Finder dev bootstrap executes the project main with its cwd, app path and refreshed environment", darwinOnly, (t) => {
  const input = fixture(t);
  const preparedApp = input.prepare();
  const before = bundleFiles(preparedApp.appRoot);
  const environmentPath = path.join(path.dirname(preparedApp.appRoot), "launch-environment.json");
  const environment = JSON.parse(fs.readFileSync(environmentPath, "utf8"));
  environment.PATH = "/new terminal/bin:/usr/bin";
  fs.writeFileSync(environmentPath, JSON.stringify(environment));
  const result = runBootstrap(input, preparedApp);
  assert.equal(result.marker, "project main evaluated");
  assert.equal(result.filename, fs.realpathSync(input.projectMain));
  assert.equal(result.cwd, fs.realpathSync(input.root));
  assert.equal(result.appPath, input.root);
  assert.deepEqual(result.environment, environment);
  assert.deepEqual(bundleFiles(preparedApp.appRoot), before, "launch only reads the external environment manifest");
});

test("Finder cold launch restores the project argv entry required by the development runtime gate", darwinOnly, (t) => {
  const input = fixture(t);
  const preparedApp = input.prepare();
  const coldLaunch = runBootstrap(input, preparedApp);
  assert.equal(coldLaunch.argv[1], input.root);
  const filePath = path.join(input.temporaryRoot, 'notes 中文 # % "quotes".md');
  const withDocument = runBootstrap(input, preparedApp, [filePath]);
  assert.equal(withDocument.argv[1], input.root);
  assert.ok(withDocument.argv.includes(filePath));
  const regularLaunch = runBootstrap(input, preparedApp, [input.root]);
  assert.equal(regularLaunch.argv.filter((item) => item === input.root).length, 1);
});

test("macOS dev PATH and Node changes update only the manifest outside the signing inputs", darwinOnly, (t) => {
  const input = fixture(t);
  const first = withLaunchEnvironment({ PATH: "/session a/bin", DESKTOP_NODE_BIN: "/session a/node" }, input.prepare);
  const environmentPath = path.join(path.dirname(first.appRoot), "launch-environment.json");
  const firstEnvironment = fs.readFileSync(environmentPath, "utf8");
  const second = withLaunchEnvironment({ PATH: "/session b/bin", DESKTOP_NODE_BIN: "/session b/node" }, input.prepare);
  assert.equal(second.appRoot, first.appRoot);
  assert.notEqual(fs.readFileSync(environmentPath, "utf8"), firstEnvironment);
  assert.equal(input.signingInputs.length, 2);
  assert.deepEqual(input.signingInputs[1], input.signingInputs[0]);
});
