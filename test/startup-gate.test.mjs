import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const projectRoot = process.cwd();
const require = createRequire(import.meta.url);
const typescript = require("typescript");

function loadStartupGate() {
  const source = fs.readFileSync(path.join(projectRoot, "src", "shared", "startup-gate.ts"), "utf8");
  const output = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  new Function("exports", "module", output)(module.exports, module);
  return module.exports;
}

const { resolveStartupSurfaceMode } = loadStartupGate();

function createStartupState(phase) {
  return {
    mode: "bootstrap",
    phase,
    serviceOrder: ["identity-center", "agent-platform", "agent-webclient"],
    currentServiceId: null,
    failedServiceId: phase === "failed" ? "agent-platform" : null,
    message: "",
    updatedAt: "",
    services: [],
  };
}

test("startup surface stays in loading mode while core services prepare", () => {
  assert.equal(resolveStartupSurfaceMode(null, false, false), "loading");
  assert.equal(resolveStartupSurfaceMode(createStartupState("running"), false, false), "loading");
  assert.equal(resolveStartupSurfaceMode(createStartupState("running"), false, true), "slow");
});

test("startup surface exposes only terminal startup states as failures", () => {
  assert.equal(resolveStartupSurfaceMode(createStartupState("failed"), false, false), "failed");
  assert.equal(resolveStartupSurfaceMode(createStartupState("succeeded"), false, false), "failed");
  assert.equal(resolveStartupSurfaceMode(createStartupState("succeeded"), true, false), null);
});

test("startup surface stays out of settings and env-import routes", () => {
  assert.equal(resolveStartupSurfaceMode(createStartupState("running"), false, false, "/settings/control"), null);
  assert.equal(resolveStartupSurfaceMode(createStartupState("env-import-required"), false, false), null);
});
