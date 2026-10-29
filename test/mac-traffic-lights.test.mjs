import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import electron from "electron";
import fs from "node:fs";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { attachMacTrafficLightLayout } from "../dist-electron/main/infrastructure/electron/mac-traffic-lights.js";

for (const platform of ["win32", "linux"]) {
  test(`${platform} never accesses native traffic light handles or registers listeners`, () => {
    const window = new Proxy({}, { get() { assert.fail("macOS adapter accessed a non-macOS window"); } });
    const dispose = attachMacTrafficLightLayout(window, {
      platform, gap: 5, centerX: 33, onError() { assert.fail("unexpected native error"); }
    });
    dispose();
  });
}

for (const architecture of ["arm64", "x64"]) {
  test(`${architecture} uses the correct Objective-C ABI and suspends/reapplies/disposes native layout`, async () => {
    const frames = [3, 26, 49].map((x) => ({ x, y: 13, width: 14, height: 14 }));
    const readFrame = (view) => view === 2n ? { x: 0, y: 0, width: 700, height: 40 } : frames[Number(view) - 10];
    const theme = new EventEmitter();
    let writes = 0;
    let stretReads = 0;
    const objc = { func(name, result, args) {
      if (name.startsWith("void *sel_registerName")) return (selector) => selector;
      if (name === "objc_msgSend_stret") {
        assert.equal(architecture, "x64");
        return (output, view) => { stretReads++; Object.assign(output, readFrame(view)); };
      }
      assert.equal(name, "objc_msgSend");
      if (result === "void *" && args.length === 3) return (_window, _selector, index) => 10n + BigInt(index);
      if (result === "void *") return (_view, selector) => selector === "window" ? 1n : 2n;
      if (result === "void") return (view, _selector, point) => { writes++; Object.assign(frames[Number(view) - 10], point); };
      assert.equal(architecture, "arm64");
      return (view) => ({ ...readFrame(view) });
    } };
    const exports = {};
    vm.runInNewContext(fs.readFileSync(new URL("../dist-electron/main/infrastructure/electron/mac-traffic-lights.js", import.meta.url), "utf8"), {
      exports, process: { arch: architecture }, setTimeout, clearTimeout,
      require(name) {
        if (name === "electron") return { nativeTheme: theme };
        assert.equal(name, "koffi");
        return { load: () => objc, struct: (value) => value, pointer: (value) => value, out: (value) => value };
      }
    });
    const window = Object.assign(new EventEmitter(), { destroyed: false, fullscreen: false, resizable: true,
      position: { x: 3, y: 13 },
      getWindowButtonPosition() { return this.position; },
      setWindowButtonPosition(position) {
        this.position = position;
        for (const [index, frame] of frames.entries()) frame.x = position.x + index * 23;
      },
      isDestroyed() { return this.destroyed; }, isFullScreen() { return this.fullscreen; },
      isResizable() { return this.resizable; }, getNativeWindowHandle() { return Buffer.alloc(8, 1); } });
    const dispose = exports.attachMacTrafficLightLayout(window, {
      platform: "darwin", gap: 5, centerX: 33, onError(error) { assert.fail(String(error)); }
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(frames.map((value) => value.x), [7, 26, 45]);
    assert.deepEqual({ ...window.position }, { x: 7, y: 13 }, "Electron margin follows the native layout");
    window.resizable = false;
    const beforeTransition = writes;
    window.emit("resize");
    theme.emit("updated");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(writes, beforeTransition, "no native writes during fullscreen transition");
    window.fullscreen = true;
    window.resizable = true;
    window.emit("enter-full-screen");
    assert.equal(writes, beforeTransition, "no native writes while fullscreen");
    window.fullscreen = false;
    frames[0].x = 3;
    window.emit("leave-full-screen");
    assert.equal(frames[0].x, 7);
    frames[2].x = 49;
    window.emit("restore");
    assert.equal(frames[2].x, 45);
    window.emit("resize");
    const beforeClose = writes;
    window.destroyed = true;
    window.emit("closed");
    dispose();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(writes, beforeClose, "closed windows cancel pending native writes");
    assert.equal(theme.listenerCount("updated"), 0);
    assert.equal(window.listenerCount("resize"), 0);
    assert.equal(stretReads > 0, architecture === "x64");
  });
}

test("native macOS traffic lights retain compact layout and system actions across window transitions", {
  skip: process.platform !== "darwin" || process.env.RUN_MAC_TRAFFIC_LIGHTS_ELECTRON_TEST !== "1",
  timeout: 45000
}, async (t) => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [fileURLToPath(new URL("./fixtures/mac-traffic-lights-electron.cjs", import.meta.url))],
    { env, stdio: ["ignore", "pipe", "pipe"] });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 40000);
  t.after(() => { clearTimeout(timeout); if (child.exitCode === null) child.kill("SIGTERM"); });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  const [code, signal] = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
  });
  assert.equal(code, 0, `${signal || ""}\n${output}`);
  assert.match(output, /MAC_TRAFFIC_LIGHTS_OK/);
  const report = JSON.parse(output.match(/MAC_TRAFFIC_LIGHTS_OK (.+)/)[1]);
  t.diagnostic(`Native ${report.architecture}: ${report.cases.map((value) => value.name).join(", ")}`);
  if (!report.minimizeTested) t.diagnostic("Native minimize/restore requires RUN_MAC_TRAFFIC_LIGHTS_MINIMIZE=1 in an interactive session; restore event handling is covered by the ABI tests.");
});
