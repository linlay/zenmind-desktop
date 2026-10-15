import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("remote document resources consume the shared document revision header", () => {
  const contracts = fs.readFileSync(path.join(projectRoot, "src", "main", "app", "ipc-registration-contracts.ts"), "utf8");
  const workpanel = fs.readFileSync(path.join(projectRoot, "src", "main", "app", "ipc-shell-workpanel.ts"), "utf8");
  assert.match(contracts, /export const PLATFORM_DOCUMENT_REVISION_HEADER = "X-Document-Revision";/u);
  assert.match(workpanel, /import \{[^}]*\bPLATFORM_DOCUMENT_REVISION_HEADER\b[^}]*\} from "\.\/ipc-registration-contracts";/u);
  assert.match(workpanel, /response\.headers\.get\(PLATFORM_DOCUMENT_REVISION_HEADER\)/u);
});
