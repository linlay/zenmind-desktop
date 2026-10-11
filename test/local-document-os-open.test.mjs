import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import electron from "electron";
import plist from "plist";
import { macDocumentTypes } from "../scripts/lib/document-file-associations.mjs";
import { bundleLocalDocumentFixture } from "./fixtures/local-document-bundle.mjs";

test("macOS Open With previews cold, warm and repeated files without creating server Chats", {
  skip: process.platform !== "darwin" || process.env.RUN_LOCAL_DOCUMENT_ELECTRON_TEST !== "1", timeout: 60000,
}, async t => {
  // LaunchServices marks apps under os.tmpdir() as in-temp-dir/launch-disabled
  // and excludes them from Finder's Open With candidates even after registration.
  const qaRoot = path.join(os.homedir(), "Applications");
  fs.mkdirSync(qaRoot, { recursive: true });
  const appContainer = fs.mkdtempSync(path.join(qaRoot, "CuteJ-Document-QA-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ld-open-"));
  const appRoot = path.join(appContainer, "CuteJ Preview QA.app");
  const register = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
  t.after(async () => {
    fs.writeFileSync(path.join(root, "quit"), "quit");
    await new Promise(resolve => setTimeout(resolve, 500));
    // A failure before the fixture entry runs cannot consume its quit marker.
    // Terminate only processes whose executable lives in this test's unique App.
    const processes = execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" });
    for (const line of processes.split("\n")) {
      const match = line.match(/^\s*(\d+)\s+(.+)$/u);
      if (match && match[2].startsWith(`${appRoot}/Contents/`)) {
        try { process.kill(Number(match[1]), "SIGTERM"); } catch {}
      }
    }
    try { execFileSync(register, ["-u", appRoot], { stdio: "ignore" }); } catch {}
    fs.rmSync(appContainer, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  execFileSync("/bin/cp", ["-cR", path.resolve(electron, "../../.."), appRoot]);
  const infoPath = path.join(appRoot, "Contents/Info.plist");
  const info = plist.parse(fs.readFileSync(infoPath, "utf8"));
  info.CFBundleIdentifier = `cc.cutej.local-document-qa.${process.pid}`;
  info.CFBundleDisplayName = "CuteJ Preview QA";
  info.CFBundleName = "CuteJ Preview QA";
  fs.renameSync(path.join(appRoot, "Contents/MacOS", info.CFBundleExecutable), path.join(appRoot, "Contents/MacOS/CuteJ Preview QA"));
  info.CFBundleExecutable = "CuteJ Preview QA";
  info.CFBundleDocumentTypes = macDocumentTypes();
  fs.writeFileSync(infoPath, plist.build(info));
  const appCode = path.join(appRoot, "Contents/Resources/app");
  fs.mkdirSync(appCode, { recursive: true });
  fs.writeFileSync(path.join(appCode, "package.json"), JSON.stringify({ name: "local-document-open-test", version: "1.0.0", main: "index.cjs" }));
  // A fresh test bundle has no TCC grant for this Desktop checkout. Bundle the
  // tested code and Worker, and isolate all writable data outside protected folders.
  await bundleLocalDocumentFixture("./local-document-os-open.cjs", appCode, root);
  execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", "--preserve-metadata=entitlements", appRoot], { stdio: "pipe", timeout: 30000 });
  execFileSync(register, ["-f", appRoot], { stdio: "ignore" });
  const markdown = path.join(root, "冷启动 中文.md");
  const html = path.join(root, "热启动 页面.htm");
  fs.writeFileSync(markdown, "# 冷启动文件\n");
  fs.writeFileSync(html, "<!doctype html><meta charset=utf-8><h1>热启动文件</h1>");
  // Ask the same LaunchServices registry that populates Finder's Open With menu.
  const handlers = execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", `
ObjC.import('AppKit');
const url = $.NSURL.fileURLWithPath(${JSON.stringify(markdown)});
const apps = $.NSWorkspace.sharedWorkspace.URLsForApplicationsToOpenURL(url);
const paths = [];
for (let i = 0; i < apps.count; i++) paths.push(ObjC.unwrap(apps.objectAtIndex(i).path));
JSON.stringify(paths);`], { encoding: "utf8" });
  assert.ok(JSON.parse(handlers).includes(appRoot), handlers);
  const waitForCount = async count => {
    for (let attempt = 0; attempt < 250; attempt++) {
      const errorPath = path.join(root, "error.txt");
      if (fs.existsSync(errorPath)) assert.fail(fs.readFileSync(errorPath, "utf8"));
      try {
        const entries = JSON.parse(fs.readFileSync(path.join(root, "events.json"), "utf8"));
        if (entries.length >= count) return entries;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    const stderr = fs.existsSync(path.join(root, "stderr.log")) ? fs.readFileSync(path.join(root, "stderr.log"), "utf8") : "";
    const startup = fs.existsSync(path.join(root, "startup.log")) ? fs.readFileSync(path.join(root, "startup.log"), "utf8") : "";
    assert.fail(`No Open With event ${count}; app ready: ${fs.existsSync(path.join(root, "ready"))}\n${startup}\n${stderr}`);
  };
  execFileSync("/usr/bin/open", ["--stdout", path.join(root, "stdout.log"), "--stderr", path.join(root, "stderr.log"), "-a", appRoot, markdown]);
  assert.equal((await waitForCount(1))[0].fileName, path.basename(markdown));
  execFileSync("/usr/bin/open", ["-a", appRoot, html]);
  assert.equal((await waitForCount(2))[1].fileName, path.basename(html));
  execFileSync("/usr/bin/open", ["-a", appRoot, markdown]);
  const events = await waitForCount(3);
  assert.deepEqual(events.map(event => event.windows), [1, 1, 1], "OS opens keep one main window");
  assert.deepEqual(events.map(event => event.tabs), [1, 2, 2], "a repeated original activates the retained local tab");
  assert.deepEqual(events.map(event => event.guests), [1, 2, 2]);
  assert.equal(new Set(events.map(event => event.mainWindowId)).size, 1);
  assert.equal(events[0].heading, "冷启动文件");
  assert.equal(events[1].heading, "热启动文件");
  assert.equal(events[1].ownerKey, events[0].ownerKey, "a different original appends to the current local draft");
  assert.notEqual(events[1].documentId, events[0].documentId);
  assert.notEqual(events[1].partition, events[0].partition);
  assert.notEqual(events[1].guestId, events[0].guestId, "files sharing one Chat keep independent guests");
  assert.deepEqual(events.map(event => event.draftGroups), [1, 1, 1]);
  assert.ok(events.every(event => event.ownerChatId === "" && event.promotedChats === 0));
  assert.equal(events[2].guestId, events[0].guestId, "repeat OS open keeps the existing guest");
  assert.equal(events[2].ownerKey, events[0].ownerKey);
  assert.equal(events[2].documentId, events[0].documentId);
  assert.equal(events[2].partition, events[0].partition);
  assert.equal(events[2].activeDocumentId, events[2].documentId);
  assert.ok(events[2].retainedDocumentIds.includes(events[0].documentId), "the first Chat retains its original document");
  assert.equal(events[2].sourcePath, events[0].sourcePath, "the retained tab refers to the same original path without a copy");
  execFileSync("/usr/bin/open", ["-a", appRoot, markdown, html]);
  const allEvents = await waitForCount(5);
  assert.deepEqual(allEvents.map(event => event.tabs), [1, 2, 2, 2, 2]);
  assert.deepEqual(allEvents.map(event => event.guests), [1, 2, 2, 2, 2]);
  assert.deepEqual(allEvents.map(event => event.draftGroups), [1, 1, 1, 1, 1]);
  assert.equal(new Set(allEvents.map(event => event.mainWindowId)).size, 1);
  assert.ok(allEvents.every(event => event.ownerChatId === "" && event.promotedChats === 0 && /^[1-9]\d{12}$/u.test(event.newChat)));
  assert.equal(new Set(allEvents.map(event => event.ownerKey)).size, 1);
  for (const field of ["documentId", "partition", "guestId"]) {
    assert.equal(new Set(allEvents.map(event => event[field])).size, 2, `different files keep independent ${field} values`);
  }
  for (const event of allEvents) {
    assert.equal(event.windows, 1);
    assert.equal(event.activeDocumentId, event.documentId);
    assert.equal(event.route, `/agent/xiaojun?newChat=${event.newChat}`);
    assert.equal(event.sourcePath, fs.realpathSync(event.fileName === path.basename(markdown) ? markdown : html));
  }
  assert.equal(fs.readFileSync(markdown, "utf8"), "# 冷启动文件\n");
  assert.equal(fs.readFileSync(html, "utf8"), "<!doctype html><meta charset=utf-8><h1>热启动文件</h1>");
  console.log("LaunchServices candidate and five OS opens passed: one local draft, no server Chats, two isolated original-file tabs and guests");
});
