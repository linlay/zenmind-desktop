import test from "node:test";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");
const {captureManagedProcessCleanupSnapshotAsync: capture} = require("../dist-electron/main/modules/services/manager/managed-cleanup.js");
function app(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-test-"));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  return {getPath: () => root};
}
test("Windows snapshot supports a bounded slow query during update", async t => {
  const fixture = app(t);
  t.mock.method(childProcess, "execFile", (_cmd, _args, options, callback) => {
    const error = options.timeout < 6000 ? Object.assign(new Error("command failed"), {killed:true, signal:"SIGTERM"}) : null;
    callback(error, JSON.stringify([{ProcessId:1, ParentProcessId:0, ExecutablePath:"C:\\Windows\\system.exe"}]), "");
    return {};
  });
  assert.deepEqual(await capture(fixture, "win32", {timeoutMs:10_000}), []);
});

test("query failure preserves exit diagnostics without logging process command lines", async t => {
  const fixture = app(t);
  t.mock.method(childProcess, "execFile", (_cmd, _args, _options, callback) => {
    callback(Object.assign(new Error("command failed"), {killed:true, signal:"SIGTERM", code:null}), "secret-process-command", "");
    return {};
  });
  await assert.rejects(capture(fixture, "win32", {timeoutMs:10_000}), error => {
    assert.match(error.message, /killed=true/);
    assert.match(error.message, /signal=SIGTERM/);
    assert.match(error.message, /timeoutMs=10000/);
    assert.match(error.message, /elapsedMs=\d+/);
    assert.doesNotMatch(error.message, /secret-process-command/);
    return true;
  });
});

test("Windows rejects missing or malformed inventory instead of treating it as no processes", async t => {
  const fixture = app(t);
  let output;
  t.mock.method(childProcess, "execFile", (_cmd, _args, _options, callback) => { callback(null, output, ""); return {}; });
  for (output of ["", "[]", "null", "{}", '{"ProcessId":"bad","ParentProcessId":0}', "not json"]) {
    await assert.rejects(capture(fixture, "win32"), /inventory|JSON/i);
  }
});

test("non-timeout query failure remains a failure with its exit code", async t => {
  const fixture = app(t);
  t.mock.method(childProcess, "execFile", (_cmd, _args, _options, callback) => {
    callback(Object.assign(new Error("command failed"), {code:1,killed:false}), "", "WMI unavailable"); return {};
  });
  await assert.rejects(capture(fixture, "win32"), /killed=false.*code=1; WMI unavailable/);
});
