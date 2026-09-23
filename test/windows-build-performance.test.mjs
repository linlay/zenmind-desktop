import assert from "node:assert/strict";
import { test } from "node:test";
import { createElectronBuildPhaseObserver } from "../scripts/platform/dist-win-host.mjs";
import { runAndWait } from "../scripts/platform/spawn.mjs";

test("electron-builder phase observer records packaging, NSIS and blockmap boundaries", () => {
  let time = 0n;
  const lines = [];
  const observer = createElectronBuildPhaseObserver(() => time, (line) => lines.push(line));

  observer.onOutputLine("stdout", "  • packaging       platform=win32 arch=x64");
  time = 37_000_000_000n;
  observer.onOutputLine("stdout", "  • building        target=nsis file=Setup.exe");
  time = 114_000_000_000n;
  observer.onOutputLine("stdout", "  • building block map  blockMapFile=Setup.exe.blockmap");
  time = 119_000_000_000n;
  observer.finish();
  observer.finish();

  assert.deepEqual(lines, [
    "[build-perf] phase=electron-packaging elapsedMs=37000 status=succeeded",
    "[build-perf] phase=nsis elapsedMs=77000 status=succeeded",
    "[build-perf] phase=blockmap elapsedMs=5000 status=succeeded"
  ]);
});

test("output observer receives subprocess lines without changing exit behavior", async () => {
  const lines = [];
  await runAndWait(process.execPath, ["-e", "console.log('packaging marker')"], {
    cwd: process.cwd(),
    shell: false,
    onOutputLine: (stream, line) => lines.push([stream, line])
  });
  assert.deepEqual(lines, [["stdout", "packaging marker"]]);
  await assert.rejects(runAndWait(process.execPath, ["-e", "process.exit(7)"], {
    cwd: process.cwd(),
    shell: false,
    onOutputLine: () => {}
  }), /exited with code 7/u);
  await assert.doesNotReject(runAndWait(process.execPath, ["-e", "console.log('observer error')"], {
    cwd: process.cwd(),
    shell: false,
    onOutputLine: () => { throw new Error("diagnostic only"); }
  }));
});
