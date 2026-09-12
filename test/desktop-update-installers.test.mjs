import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Module, { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { promisify } from "node:util";
const require = createRequire(import.meta.url);
const updater = new EventEmitter();
const calls = [];
let feedHandler;
let nativeFailure = false;
let spawnFailure = false;
const updaterMethods = {
  setFeedURL: (options) => { calls.push(["feed", options]); },
  checkForUpdates: () => queueMicrotask(() => updater.emit(nativeFailure ? "error" : "update-downloaded", nativeFailure ? new Error("signature invalid") : undefined)),
  quitAndInstall: () => calls.push(["quitAndInstall"])
};
Object.assign(updater, updaterMethods);
const execFile = () => {};
execFile[promisify.custom] = async (command, args) => { calls.push(["exec", command, args]); return { stdout: "", stderr: "TeamIdentifier=ABCDE12345\n" }; };
const handlers = new Map();
const powerMonitor = new EventEmitter();
const electron = { autoUpdater: updater, powerMonitor, ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: (name) => handlers.delete(name) } };
const originalLoad = Module._load;
Module._load = function(id, ...args) {
  if (id === "electron") return electron;
  if (id === "node:child_process") return { execFile, spawn: (file, argv, options) => {
    calls.push(["spawn", file, argv, options]);
    const child = new EventEmitter(); child.unref = () => {};
    queueMicrotask(() => spawnFailure ? child.emit("error", Object.assign(new Error("elevation needed"), { code: "EACCES" })) : child.emit("spawn"));
    return child;
  } };
  if (id === "node:http") return { createServer: (handler) => {
    feedHandler = handler;
    const server = new EventEmitter(); server.listen = (_port, host, done) => { assert.equal(host, "127.0.0.1"); done(); }; server.address = () => ({ port: 34567 }); server.closeAllConnections = () => {}; server.close = () => {};
    return server;
  } };
  return originalLoad.call(this, id, ...args);
};
const installer = require("../dist-electron/main/modules/updates/installer.js");
const { registerDesktopUpdates } = require("../dist-electron/main/modules/updates/ipc.js");
Module._load = originalLoad;

test("macOS stages only a loopback token feed and invokes native install on success", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "update-native-test-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "app.zip"); fs.writeFileSync(file, "zip fixture"); calls.length = 0;
  await installer.installMacUpdate(file, "0.5.0");
  assert.equal(calls.at(-1)[0], "quitAndInstall");
  const url = calls.find(([name]) => name === "feed")[1].url;
  assert.match(url, /^http:\/\/127\.0\.0\.1:34567\/[a-f0-9]{48}\/feed$/);
  let status, body;
  const response = { setHeader() {}, writeHead(value) { status = value; return this; }, end(value) { body = value; } };
  feedHandler({ method: "GET", url: "/wrong", headers: { host: "127.0.0.1:34567" } }, response); assert.equal(status, 404);
  feedHandler({ method: "GET", url: new URL(url).pathname, headers: { host: "127.0.0.1:34567" } }, response);
  assert.equal(JSON.parse(body).name, "0.5.0"); assert.ok(JSON.parse(body).url.endsWith("/update.zip"));
  nativeFailure = true; calls.length = 0;
  await assert.rejects(installer.installMacUpdate(file, "0.5.0"), /signature invalid/);
  assert.equal(calls.some(([name]) => name === "quitAndInstall"), false);
});
test("macOS host preflight rejects mounted media and unsigned layout", async () => {
  await assert.rejects(installer.verifyMacUpdateHost("/Volumes/CuteJ/CuteJ.app/Contents/MacOS/CuteJ"));
  await assert.rejects(installer.verifyMacUpdateHost("/tmp/CuteJ"));
  calls.length = 0;
  await installer.verifyMacUpdateHost("/Applications/CuteJ.app/Contents/MacOS/CuteJ");
  assert.deepEqual(calls[0].slice(1), ["/usr/bin/codesign", ["--verify", "--deep", "--strict", "/Applications/CuteJ.app"]]);
});
test("Windows validates publisher and launches the existing NSIS update path", async () => {
  calls.length = 0;
  await installer.verifyWindowsPublisher("C:\\Cache\\user's app.exe", "C:\\Apps\\CuteJ.exe");
  const signatureScript = Buffer.from(calls[0][2].at(-1), "base64").toString("utf16le");
  assert.match(signatureScript, /Get-AuthenticodeSignature/); assert.match(signatureScript, /SignerCertificate.Subject/); assert.match(signatureScript, /user''s app/);
  await installer.launchWindowsUpdate("C:\\Cache\\update.exe");
  assert.deepEqual(calls.find(([name]) => name === "spawn")[2], ["--updated", "/S", "--force-run"]);
  spawnFailure = true; calls.length = 0;
  await installer.launchWindowsUpdate("C:\\Cache\\update.exe");
  assert.match(Buffer.from(calls.find(([name]) => name === "exec")[2].at(-1), "base64").toString("utf16le"), /-Verb RunAs/);
});
test("update IPC rejects guest frames and other windows, cleans up handlers", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "update-ipc-test-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = new EventEmitter(); app.getPath = () => root; app.isPackaged = false;
  const mainFrame = {}; const sender = { mainFrame, send() {} };
  registerDesktopUpdates({ app, currentVersion: "0.4.1", getMainWindow: () => ({ isDestroyed: () => false, webContents: sender }), prepareInstall: async () => assert.fail("cannot install"), quit: () => assert.fail("cannot quit") });
  const read = handlers.get("updates.getState");
  assert.throws(() => read({ sender: {}, senderFrame: mainFrame }), /Untrusted/);
  assert.throws(() => read({ sender, senderFrame: {} }), /Untrusted/);
  assert.equal(read({ sender, senderFrame: mainFrame }).phase, "disabled");
  app.emit("will-quit"); assert.equal(handlers.size, 0); assert.equal(powerMonitor.listenerCount("resume"), 0);
});
