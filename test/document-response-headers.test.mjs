import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("remote document resources consume the shared document revision header", () => {
  const source = fs.readFileSync(path.join(projectRoot, "src", "main", "ipc", "register.ts"), "utf8");
  assert.match(source, /const PLATFORM_DOCUMENT_REVISION_HEADER = "X-Document-Revision";/u);
  assert.match(source, /response\.headers\.get\(PLATFORM_DOCUMENT_REVISION_HEADER\)/u);
});
