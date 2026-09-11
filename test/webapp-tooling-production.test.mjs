import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { brandBundleElectronDir, loadBrandConfig, resolveBrandId } from "../scripts/lib/brand-config.mjs";
import { electronBuilderConfig } from "../scripts/lib/brand-packaging.mjs";

const projectRoot = process.cwd();
const require = createRequire(import.meta.url);
const JSZip = require("jszip");
const { executeWebappToolingInWorker } = require("../dist-electron/main/modules/webs/webapps/tooling/worker.js");
const {
  sanitizeAgentRealtimeDebugValue
} = require("../dist-electron/main/modules/agent-platform/realtime/realtime-debug-trace.js");

test("Desktop Main TypeScript is the only authoritative WebApp Tooling implementation", () => {
  assert.equal(fs.existsSync(path.join(projectRoot, "src/main/modules/webs/webapps/tooling/service.ts")), true);
  assert.equal(fs.existsSync(path.join(projectRoot, "src/main/modules/webs/webapps/tooling/worker.ts")), true);
  for (const removedPath of [
    "src/tooling/webapp-tooling.ts",
    "scripts/generate-webapp-tooling-bundle.mjs",
    "scripts/run-webapp-tooling.mjs",
    "scripts/lib/webapp-tooling-resource.js",
    "tsconfig.tooling.json"
  ]) {
    assert.equal(fs.existsSync(path.join(projectRoot, removedPath)), false, removedPath);
  }
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  assert.equal(Object.keys(packageJson.scripts).some((name) => name.startsWith("webapp:") || name.includes("tooling")), false);
  const serviceManagerRoot = path.join(projectRoot, "src/main/modules/services/manager");
  const serviceManagerSource = fs.readdirSync(serviceManagerRoot)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => fs.readFileSync(path.join(serviceManagerRoot, name), "utf8"))
    .join("\n");
  assert.equal(serviceManagerSource.includes("DESKTOP_WEBAPP_TOOLING_PATH"), false);
  assert.equal(/env\.DESKTOP_ROOT\b/u.test(serviceManagerSource), false);
});

test("trusted Workspace roots are redacted from realtime diagnostics", () => {
  assert.deepEqual(
    sanitizeAgentRealtimeDebugValue({
      source: { runId: "run-1", workspaceRoot: "/private/workspaces/run-1" },
      nested: { workspace_root: "C:\\private\\workspaces\\run-1" }
    }),
    {
      source: { runId: "run-1", workspaceRoot: "<REDACTED>" },
      nested: { workspace_root: "<REDACTED>" }
    }
  );
});

test("one-shot Tooling Worker completes the workspace-relative package workflow", async (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-webapp-tooling-worker-"));
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
  const workerPath = path.join(projectRoot, "dist-electron/main/modules/webs/webapps/tooling/worker.js");
  const run = (task) => executeWebappToolingInWorker(task, { workerPath });

  const initialized = await run({
    operation: "package.init",
    workspaceRoot,
    projectPath: "apps/example",
    key: "production-example",
    label: "Production Example"
  });
  assert.equal(initialized.projectPath, "apps/example");
  assert.equal(initialized.manifestPath, "apps/example/webapp.json");
  assert.equal(JSON.stringify(initialized).includes(workspaceRoot), false);
  assert.equal("ok" in initialized, false);
  assert.equal("message" in initialized, false);

  const indexPath = path.join(workspaceRoot, "apps/example/frontend/index.html");
  fs.writeFileSync(indexPath, "<!doctype html><title>Custom</title>\n");
  const initializedAgain = await run({
    operation: "package.init",
    workspaceRoot,
    projectPath: "apps/example",
    key: "ignored-key",
    label: "Ignored Label"
  });
  assert.equal(initializedAgain.id, initialized.id);
  assert.equal(initializedAgain.key, initialized.key);
  assert.equal(fs.readFileSync(indexPath, "utf8"), "<!doctype html><title>Custom</title>\n");

  const project = await run({
    operation: "package.validate",
    workspaceRoot,
    projectPath: "apps/example"
  });
  assert.ok(project.fileCount >= 2);
  assert.equal(project.id, initialized.id);

  const built = await run({
    operation: "package.build",
    workspaceRoot,
    projectPath: "apps/example",
    outputPath: "artifacts/example.zip"
  });
  assert.match(built.sha256, /^[a-f\d]{64}$/u);
  assert.equal(built.outputPath, "artifacts/example.zip");

  const archive = await run({
    operation: "package.validate",
    workspaceRoot,
    archivePath: "artifacts/example.zip"
  });
  assert.equal(archive.id, initialized.id);
  assert.equal(JSON.stringify(archive).includes(workspaceRoot), false);
});

test("electron-builder keeps Tooling inside app.asar and publishes no independent resource script", () => {
  const brand = loadBrandConfig(projectRoot, "cutej");
  for (const target of [
    { os: "darwin", arch: "arm64" },
    { os: "win32", arch: "x64" }
  ]) {
    const config = electronBuilderConfig(brand, target);
    assert.ok(config.files.includes("dist-electron/**/*"));
    assert.equal(config.asarUnpack.some((item) => item.includes("webapp-tooling")), false);
    assert.equal(config.extraResources.some((item) => JSON.stringify(item).includes("webapp-tooling")), false);
  }
  const activeBrand = loadBrandConfig(projectRoot, resolveBrandId());
  assert.equal(
    fs.existsSync(path.join(brandBundleElectronDir(projectRoot, activeBrand), "main/webapp-tooling-worker.js")),
    true
  );
});

test("Tooling rejects workspace escapes, ZIP Slip, compression bombs, and output overwrite", async (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-webapp-tooling-security-"));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-webapp-tooling-outside-"));
  t.after(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  });
  const workerPath = path.join(projectRoot, "dist-electron/main/modules/webs/webapps/tooling/worker.js");
  const run = (task, options = {}) => executeWebappToolingInWorker(task, { workerPath, ...options });
  const initialized = await run({
    operation: "package.init",
    workspaceRoot,
    projectPath: "app",
    key: "security-example",
    label: "Security Example"
  });

  const escapePath = path.join(workspaceRoot, "escape");
  let symlinksAvailable = true;
  try {
    fs.symlinkSync(outsideRoot, escapePath, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (process.platform !== "win32" || error.code !== "EPERM") throw error;
    symlinksAvailable = false;
  }
  if (symlinksAvailable) {
    await assert.rejects(
      run({ operation: "package.validate", workspaceRoot, projectPath: "escape" }),
      (error) => error.code === "path_outside_workspace"
    );
  }

  const linkedFile = path.join(workspaceRoot, "app", "frontend", "linked.txt");
  fs.writeFileSync(path.join(outsideRoot, "secret.txt"), "secret");
  if (symlinksAvailable) {
    try {
      fs.symlinkSync(path.join(outsideRoot, "secret.txt"), linkedFile, "file");
      await assert.rejects(
        run({ operation: "package.validate", workspaceRoot, projectPath: "app" }),
        (error) => error.code === "symbolic_link"
      );
      fs.rmSync(linkedFile);
    } catch (error) {
      if (process.platform !== "win32" || error.code !== "EPERM") throw error;
    }
  }

  const built = await run({
    operation: "package.build",
    workspaceRoot,
    projectPath: "app",
    outputPath: "artifacts/app.zip"
  });
  await assert.rejects(
    run({
      operation: "package.build",
      workspaceRoot,
      projectPath: "app",
      outputPath: "artifacts/app.zip"
    }),
    (error) => error.stage === "package" && error.code === "output_exists" && Boolean(error.details.suggestion)
  );
  assert.equal(
    (await run({ operation: "package.validate", workspaceRoot, archivePath: "artifacts/app.zip" })).sha256,
    built.sha256
  );

  const manifestBytes = fs.readFileSync(path.join(workspaceRoot, "app", "webapp.json"));
  const slipZip = new JSZip();
  slipZip.file(`${initialized.id}/webapp.json`, manifestBytes);
  slipZip.file(`${initialized.id}/frontend/index.html`, "<!doctype html>");
  slipZip.file("../escaped.txt", "escaped");
  fs.writeFileSync(
    path.join(workspaceRoot, "slip.zip"),
    await slipZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
  );
  await assert.rejects(
    run({ operation: "package.validate", workspaceRoot, archivePath: "slip.zip" }),
    (error) => error.code === "unsafe_path"
  );

  const bombZip = new JSZip();
  bombZip.file(`${initialized.id}/webapp.json`, manifestBytes);
  bombZip.file(`${initialized.id}/frontend/index.html`, "<!doctype html>");
  bombZip.file(`${initialized.id}/high-ratio.txt`, "0".repeat(2 * 1024 * 1024));
  fs.writeFileSync(
    path.join(workspaceRoot, "bomb.zip"),
    await bombZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } })
  );
  await assert.rejects(
    run({ operation: "package.validate", workspaceRoot, archivePath: "bomb.zip" }),
    (error) => error.code === "compression_ratio_exceeded"
  );

  await assert.rejects(
    executeWebappToolingInWorker({
      operation: "package.build",
      workspaceRoot,
      projectPath: "app",
      outputPath: "artifacts/timeout.zip"
    }, {
      workerPath: path.join(projectRoot, "test/fixtures/webapp-tooling-timeout-worker.cjs"),
      timeoutMs: 200
    }),
    (error) => error.code === "tooling_timeout"
  );
  assert.equal(fs.existsSync(path.join(workspaceRoot, "artifacts", "timeout.zip")), false);
  assert.equal(
    fs.readdirSync(path.join(workspaceRoot, "artifacts")).some((name) => name.includes("timeout.zip") && name.endsWith(".tmp.zip")),
    false
  );
});
