const fs = require("node:fs");
const path = require("node:path");
const { workerData } = require("node:worker_threads");

const outputPath = path.resolve(
  workerData.workspaceRoot,
  ...String(workerData.outputPath).replace(/\\/gu, "/").split("/"),
);
const temporaryPath = path.join(
  path.dirname(outputPath),
  `.${path.basename(outputPath)}.${workerData._temporaryToken}.tmp.zip`,
);

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(temporaryPath, "uncommitted-test-archive", { flag: "wx" });
fs.linkSync(temporaryPath, outputPath);
setInterval(() => undefined, 1_000);
