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

const { shouldShowStartupProgressCard } = loadStartupGate();

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

test("startup progress card stays visible while core services prepare or fail", () => {
  assert.equal(shouldShowStartupProgressCard(null, false), true);
  assert.equal(shouldShowStartupProgressCard(createStartupState("idle"), false), true);
  assert.equal(shouldShowStartupProgressCard(createStartupState("running"), false), true);
  assert.equal(shouldShowStartupProgressCard(createStartupState("failed"), false), true);
});

test("startup progress card follows live readiness after startup completes", () => {
  assert.equal(shouldShowStartupProgressCard(createStartupState("succeeded"), false), true);
  assert.equal(shouldShowStartupProgressCard(createStartupState("succeeded"), true), false);
});

test("startup progress card stays out of settings and env-import routes", () => {
  assert.equal(shouldShowStartupProgressCard(createStartupState("running"), false, "/settings/control"), false);
  assert.equal(shouldShowStartupProgressCard(createStartupState("env-import-required"), false), false);
});
