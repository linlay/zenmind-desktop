import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const projectRoot = process.cwd();
const timeContractPath = path.join(projectRoot, "src", "shared", "time-contract.ts");

function loadTimeContractModule() {
  const source = fs.readFileSync(timeContractPath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: timeContractPath,
  });
  const mod = { exports: {} };
  new Function("exports", "require", "module", outputText)(mod.exports, require, mod);
  return mod.exports;
}

const {
  EPOCH_MILLIS_MAX,
  EPOCH_MILLIS_MIN,
  TimeContractViolation,
  assertEpochMillis,
  formatEpochMillis,
  isEpochMilliseconds,
  parseOptionalEpochMillis,
  readEpochMillis,
  requireEpochMillis,
} = loadTimeContractModule();

function expectViolation(callback, field, reason) {
  assert.throws(callback, (error) => {
    assert.equal(error instanceof TimeContractViolation, true);
    assert.equal(error.field, field);
    assert.equal(error.reason, reason);
    assert.equal(error.code, "time_contract_violation");
    return true;
  });
}

test("epoch-ms accepts only non-negative Date-representable safe integers", () => {
  for (const value of [EPOCH_MILLIS_MIN, 0, 1, 1_710_000_000, EPOCH_MILLIS_MAX]) {
    assert.equal(isEpochMilliseconds(value), true);
    assert.equal(readEpochMillis(value), value);
    assert.equal(requireEpochMillis(value, "timestamp"), value);
  }

  for (const value of [
    -1,
    EPOCH_MILLIS_MAX + 1,
    Number.MAX_SAFE_INTEGER,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    "0",
    "1710000000000",
    "2026-07-14T00:00:00.000Z",
    "",
  ]) {
    assert.equal(isEpochMilliseconds(value), false);
    assert.equal(readEpochMillis(value), undefined);
    expectViolation(() => requireEpochMillis(value, "timestamp"), "timestamp", "invalid");
  }
});

test("required and optional epoch-ms parsers keep absence distinct from invalid values", () => {
  expectViolation(() => assertEpochMillis(undefined, "createdAt"), "createdAt", "missing");
  expectViolation(() => requireEpochMillis(null, "createdAt"), "createdAt", "missing");

  assert.equal(parseOptionalEpochMillis(undefined, "updatedAt"), undefined);
  assert.equal(parseOptionalEpochMillis(null, "updatedAt"), undefined);
  assert.equal(parseOptionalEpochMillis(0, "updatedAt"), 0);

  expectViolation(() => parseOptionalEpochMillis("", "updatedAt"), "updatedAt", "invalid");
  expectViolation(
    () => parseOptionalEpochMillis("2026-07-14T00:00:00.000Z", "updatedAt"),
    "updatedAt",
    "invalid",
  );
});

test("renderer formatter accepts epoch-ms and delegates localization to Intl", () => {
  const timestamp = requireEpochMillis(0, "timestamp");
  const defaultOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  };
  assert.equal(
    formatEpochMillis(timestamp, "en-CA"),
    new Intl.DateTimeFormat("en-CA", defaultOptions).format(timestamp),
  );
  assert.equal(
    formatEpochMillis(timestamp, "en-CA", { year: "numeric", timeZone: "UTC" }),
    new Intl.DateTimeFormat("en-CA", { year: "numeric", timeZone: "UTC" }).format(timestamp),
  );
  expectViolation(
    () => formatEpochMillis("0", "en-CA"),
    "formatEpochMillis",
    "invalid",
  );
});

test("time contract does not add Date.parse or Date.now fallback behavior", () => {
  const source = fs.readFileSync(timeContractPath, "utf8");
  assert.doesNotMatch(source, /\bDate\.parse\s*\(/u);
  assert.doesNotMatch(source, /\bDate\.now\s*\(/u);
});

function collectTypeScriptFiles(root, files = []) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "generated") {
      continue;
    }
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      collectTypeScriptFiles(entryPath, files);
    } else if (entry.name.endsWith(".ts")) {
      files.push(entryPath);
    }
  }
  return files;
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  return node.getText();
}

function containsStringType(type) {
  if ((type.flags & ts.TypeFlags.StringLike) !== 0) {
    return true;
  }
  return type.isUnionOrIntersection?.() && type.types.some(containsStringType);
}

function findSharedStringTimeFields() {
  const sharedRoot = path.join(projectRoot, "src", "shared");
  const files = collectTypeScriptFiles(sharedRoot);
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    strict: true,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const fields = [];

  for (const filePath of files) {
    const sourceFile = program.getSourceFile(filePath);
    if (!sourceFile) {
      continue;
    }
    const relativePath = path.relative(projectRoot, filePath);
    const visit = (node) => {
      if (ts.isPropertySignature(node) && node.name && node.type) {
        const name = propertyName(node.name);
        if ((/At$/u.test(name) || /timestamp$/iu.test(name)) &&
          containsStringType(checker.getTypeFromTypeNode(node.type))) {
          fields.push(`${relativePath}#${name}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return fields.sort();
}

const LEGACY_SHARED_STRING_TIME_FIELDS = [
  "src/shared/contracts/desktop-api.ts#capturedAt",
  "src/shared/contracts/desktop-api.ts#changedAt",
  "src/shared/contracts/desktop-api.ts#createdAt",
  "src/shared/contracts/desktop-api.ts#expiresAt",
  "src/shared/contracts/desktop-api.ts#expiresAt",
  "src/shared/contracts/desktop-api.ts#fetchedAt",
  "src/shared/contracts/desktop-api.ts#fetchedAt",
  "src/shared/contracts/desktop-api.ts#issuedAt",
  "src/shared/contracts/desktop-api.ts#lastMachineMismatchAt",
  "src/shared/contracts/desktop-api.ts#updatedAt",
  "src/shared/contracts/desktop-api.ts#updatedAt",
  "src/shared/contracts/kanban.ts#createdAt",
  "src/shared/contracts/kanban.ts#createdAt",
  "src/shared/contracts/kanban.ts#createdAt",
  "src/shared/contracts/kanban.ts#createdAt",
  "src/shared/contracts/kanban.ts#dispatchUpdatedAt",
  "src/shared/contracts/kanban.ts#lastSyncedAt",
  "src/shared/contracts/kanban.ts#syncSinceAt",
  "src/shared/contracts/kanban.ts#updatedAt",
  "src/shared/contracts/kanban.ts#updatedAt",
  "src/shared/contracts/kanban.ts#updatedAt",
  "src/shared/contracts/marketplace.ts#createdAt",
  "src/shared/contracts/marketplace.ts#createdAt",
  "src/shared/contracts/marketplace.ts#imageCreatedAt",
  "src/shared/contracts/marketplace.ts#publishedAt",
  "src/shared/contracts/marketplace.ts#publishedAt",
  "src/shared/contracts/marketplace.ts#updatedAt",
  "src/shared/contracts/marketplace.ts#updatedAt",
  "src/shared/contracts/services.ts#checkedAt",
  "src/shared/contracts/services.ts#lastConnectedAt",
  "src/shared/contracts/services.ts#lastRegisteredAt",
  "src/shared/contracts/services.ts#lastRegisteredAt",
  "src/shared/contracts/startup.ts#updatedAt",
  "src/shared/contracts/webs.ts#changedAt",
  "src/shared/contracts/webs.ts#expiresAt",
  "src/shared/contracts/webs.ts#expiresAt",
  "src/shared/contracts/webs.ts#startedAt",
  "src/shared/contracts/webs.ts#updatedAt",
  "src/shared/contracts/webs.ts#updatedAt",
  "src/shared/desktop-ws-protocol.ts#desktopIdentityCreatedAt",
  "src/shared/desktop-ws-protocol.ts#expiresAt",
].sort();

test("shared contracts do not add string *At or *timestamp fields", () => {
  assert.deepEqual(findSharedStringTimeFields(), LEGACY_SHARED_STRING_TIME_FIELDS);
  const contractsBarrel = fs.readFileSync(path.join(projectRoot, "src", "shared", "contracts.ts"), "utf8");
  assert.match(contractsBarrel, /export \* from "\.\/time-contract";/u);
});
