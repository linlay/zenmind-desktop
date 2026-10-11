import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import electron from "electron";
import { bundleLocalDocumentFixture } from "./fixtures/local-document-bundle.mjs";

test("file previews stay local until canonical promotion and preserve isolated guests across file groups", {
  skip: process.env.RUN_LOCAL_DOCUMENT_ELECTRON_TEST !== "1", timeout: 60000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-document-electron-"));
  if (process.env.LOCAL_DOCUMENT_KEEP_TEST_OUTPUT === "1") console.log("Document workspace outputs:", root);
  else t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = await bundleLocalDocumentFixture("./local-document-electron.cjs", path.join(root, "app"), root);
  const env = { ...process.env, LOCAL_DOCUMENT_TEST_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [fixture], { env, stdio: ["ignore", "pipe", "pipe"] });
  const timer = setTimeout(() => child.kill("SIGTERM"), 55000);
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGTERM"); });
  let output = "";
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { output += data; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(code, 0, output);
  const receipt = JSON.parse(fs.readFileSync(path.join(root, "passed.json"), "utf8"));
  assert.equal(receipt.ok, true);
  assert.deepEqual(receipt.counts, { initialConcurrentDocuments: 2, initialDraftGroups: 1, draftGroups: 2, promotedChats: 2, simultaneousMainWindows: 1, sameOriginalHtmlPreviews: 2 });
  console.log("Deferred Chat and isolated preview Electron checks:", JSON.stringify(receipt.counts));
});
