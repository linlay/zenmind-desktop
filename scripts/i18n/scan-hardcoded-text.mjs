import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const srcRoot = path.join(projectRoot, "src");
const allowed = new Set([
  path.join(srcRoot, "shared", "i18n", "dictionaries", "zhCN.ts")
]);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return walk(target);
    }
    return target;
  });
}

const matches = [];
for (const filePath of walk(srcRoot)) {
  if (!/\.(ts|tsx)$/u.test(filePath) || allowed.has(filePath)) {
    continue;
  }
  const source = fs.readFileSync(filePath, "utf8");
  if (/[\p{Script=Han}]/u.test(source)) {
    matches.push(path.relative(projectRoot, filePath));
  }
}

if (matches.length > 0) {
  console.log("Hardcoded Han text remains in:");
  for (const match of matches) {
    console.log(`- ${match}`);
  }
  if (process.argv.includes("--strict")) {
    process.exitCode = 1;
  }
} else {
  console.log("No hardcoded Han text found outside i18n dictionaries.");
}
