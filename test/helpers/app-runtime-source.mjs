import fs from "node:fs";
import path from "node:path";

// Read the composition root and its explicit assembly units for source-level contracts.
export function readAppRuntimeSource(projectRoot) {
  const appRoot = path.join(projectRoot, "src/main/app");
  const root = fs.readFileSync(path.join(appRoot, "runtime.ts"), "utf8");
  const units = [...root.matchAll(/from "\.\/(assembly\/[^"\n]+|lifecycle\/(?:app-ready|runtime-events|startup-assembly|shutdown-assembly)|runtime-notifications|renderer-diagnostics|resource-directory-watcher)"/gu)]
    .map((match) => match[1]);
  return [root, ...new Set(units)].map((unit, index) => index === 0
    ? unit
    : fs.readFileSync(path.join(appRoot, `${unit}.ts`), "utf8")).join("\n");
}
