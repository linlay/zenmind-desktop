// Run with Electron after build:main:prepared. All input files must be generated
// fixtures; --launch explicitly enables opening the test files directly.
const { app } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createDocumentLocalOpenService } = require("../dist-electron/main/modules/work-panel/document-local-open.js");
const { createWorkPanelDocumentReader } = require("../dist-electron/main/modules/work-panel/document-local-reader.js");

const fixtureRoot = path.resolve(process.argv[2] || ".cache/office-local-open-acceptance/fixtures");
const copyRoot = path.join(path.dirname(fixtureRoot), "copies");
const launch = process.argv.includes("--launch");
const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

app.whenReady().then(async () => {
  await fs.mkdir(copyRoot, { recursive: true });
  const service = createDocumentLocalOpenService({
    readDocument: createWorkPanelDocumentReader({
      app,
      getWorkspace: async () => fixtureRoot,
      verifyChatOwner: async () => false,
      fetchResource: async () => { throw new Error("Local fixture must never download"); },
      resolveRuntimeRoot: () => path.join(copyRoot, "unused-runtime"),
    }),
    showSaveDialog: async () => { throw new Error("Direct opening must not display a save dialog"); },
    getDownloadsPath: () => copyRoot,
    getCachePath: () => path.join(copyRoot, "cache"),
  });
  const receipts = [];
  for (const fileName of (await fs.readdir(fixtureRoot)).filter((name) => /\.(docx|xlsx|pptx|pdf)$/i.test(name))) {
    const source = { kind: "workspace-file", agentKey: "acceptance-fixture", path: fileName };
    const before = digest(await fs.readFile(path.join(fixtureRoot, fileName)));
    const options = await service.getOptions(source, () => true);
    assert.equal(options.ok, true, JSON.stringify(options));
    const selected = options.applications.find((candidate) => candidate.isDefault) || options.applications[0];
    assert.ok(selected, `No installed application for ${fileName}`);
    assert.equal("path" in selected, false);
    assert.ok(selected.iconDataUrl?.startsWith("data:image/png;base64,"), "Electron returned the real application icon");
    let result;
    if (launch) {
      result = await service.openDocument(source, selected.id, () => true);
      assert.deepEqual(result, { ok: true, status: "launch-requested" });
    }
    assert.equal(digest(await fs.readFile(path.join(fixtureRoot, fileName))), before);
    receipts.push({ fileName, application: selected.name, candidateCount: options.applications.length, icon: true,
      originalUnchanged: true, ...(result ? { status: result.status } : {}) });
  }
  await fs.writeFile(path.join(path.dirname(fixtureRoot), "native-receipts.json"), JSON.stringify(receipts, null, 2));
  console.log(JSON.stringify(receipts, null, 2));
  app.quit();
}).catch((error) => { console.error(error); app.exit(1); });
