import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import electron from "electron";
import { loadBrandConfig, resolveBrandId, runtimeBrandPayload } from "../scripts/lib/brand-config.mjs";

test("real Electron HTML preview integration", { skip: process.env.RUN_HTML_ELECTRON_TEST !== "1", timeout: 90000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "document-html-electron-"));
  if (process.env.HTML_KEEP_TEST_OUTPUT !== "1") t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  else console.log("HTML integration outputs:", root);
  await build({ entryPoints: [fileURLToPath(new URL("./fixtures/document-html-react.tsx", import.meta.url))],
    outfile: path.join(root, "react-host.js"), bundle: true, platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"',
      __DESKTOP_APP_BRAND__: JSON.stringify(runtimeBrandPayload(loadBrandConfig(process.cwd(), resolveBrandId()))) } });
  const env = { ...process.env, HTML_TEST_ROOT: root,
    HTML_REVIEW_PRELOAD_PATH: process.env.HTML_REVIEW_PRELOAD_PATH || fileURLToPath(new URL("../dist-electron/preload/document-html-review.js", import.meta.url)) };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [fileURLToPath(new URL("./fixtures/document-html-electron.cjs", import.meta.url))], { env, stdio: ["ignore", "pipe", "pipe"] });
  const timer = setTimeout(() => child.kill("SIGTERM"), 80000);
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGTERM"); });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  const [code, signal] = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve([code, signal])); });
  console.log(output);
  assert.equal(code, 0, `${signal || ""}\n${output}`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "passed.json"), "utf8")).ok, true);
});
