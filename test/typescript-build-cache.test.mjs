import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");
const compiler = path.join(projectRoot, "node_modules", "typescript", "bin", "tsc");

function effectiveOptions(projectFile) {
  const output = execFileSync(process.execPath, [compiler, "--showConfig", "-p", projectFile], {
    cwd: projectRoot,
    encoding: "utf8"
  });
  return JSON.parse(output).compilerOptions;
}

test("production TypeScript projects retain independent incremental state across Desktop output cleanup", () => {
  const main = effectiveOptions("tsconfig.main.json");
  const renderer = effectiveOptions("tsconfig.json");

  for (const options of [main, renderer]) {
    assert.equal(options.incremental, true);
    assert.match(options.tsBuildInfoFile, /^\.\/\.cache\/typescript\/[^/]+\.tsbuildinfo$/u);
  }
  assert.notEqual(main.tsBuildInfoFile, renderer.tsBuildInfoFile);
});
