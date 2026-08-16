import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(repoRoot, "src", "shared", "contracts", "agent-webclient-bridge.ts");
const outputPath = path.join(repoRoot, "contracts", "agent-webclient", "agent-webclient-bridge.ts");
const checkOnly = process.argv.slice(2).includes("--check");

const source = fs.readFileSync(sourcePath, "utf8").replace(/\r\n/gu, "\n").trimEnd();
const digest = crypto.createHash("sha256").update(source).digest("hex");
const generated = [
  "// Generated from src/shared/contracts/agent-webclient-bridge.ts.",
  "// Do not edit this mirror directly.",
  `// sha256:${digest}`,
  "",
  source,
  "",
].join("\n");

if (checkOnly) {
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
  if (current !== generated) {
    throw new Error(`generated Agent WebClient bridge contract is stale: ${path.relative(repoRoot, outputPath)}`);
  }
} else {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, generated, "utf8");
}
