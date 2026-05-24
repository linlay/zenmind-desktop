import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dictionariesRoot = path.join(projectRoot, "src", "shared", "i18n", "dictionaries");

function extractMessages(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const entries = new Map();
  const entryPattern = /^\s*"([^"]+)":\s*"((?:\\"|[^"])*)"/gm;
  let match;
  while ((match = entryPattern.exec(source))) {
    entries.set(match[1], match[2]);
  }
  return entries;
}

function placeholders(value) {
  return [...value.matchAll(/\{([A-Za-z0-9_.-]+)\}/g)].map((match) => match[1]).sort();
}

const basePath = path.join(dictionariesRoot, "zhCN.ts");
const enPath = path.join(dictionariesRoot, "enUS.ts");
const zh = extractMessages(basePath);
const en = extractMessages(enPath);
const failures = [];

for (const [key, value] of zh) {
  if (!value.trim()) {
    failures.push(`zh-CN ${key} is empty`);
  }
  if (!en.has(key)) {
    failures.push(`en-US missing key ${key}`);
    continue;
  }
  const left = placeholders(value).join(",");
  const right = placeholders(en.get(key)).join(",");
  if (left !== right) {
    failures.push(`placeholder mismatch for ${key}: zh-CN={${left}} en-US={${right}}`);
  }
}

for (const [key, value] of en) {
  if (!value.trim()) {
    failures.push(`en-US ${key} is empty`);
  }
  if (!zh.has(key)) {
    failures.push(`zh-CN missing key ${key}`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`validated ${zh.size} i18n keys`);
