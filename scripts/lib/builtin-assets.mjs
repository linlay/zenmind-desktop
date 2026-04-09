import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const builtinServices = [
  {
    id: "agent-container-hub",
    sourceDir: "/Users/linlay/Project/zenmind/agent-container-hub/dist/release",
    assetFileName: "agent-container-hub-program-v0.1.0-darwin-arm64.tar.gz",
    bundleTopLevelDir: "agent-container-hub",
    version: "v0.1.0",
    requiredBundleEntries: [
      "agent-container-hub",
      "start.sh",
      "stop.sh",
      ".env.example",
      "configs/environments/"
    ]
  },
  {
    id: "pan-webclient",
    sourceDir: "/Users/linlay/Project/zenmind/pan-webclient/dist/release",
    assetFileName: "pan-webclient-program-v0.1.0-darwin-arm64.tar.gz",
    bundleTopLevelDir: "pan-webclient",
    version: "v0.1.0",
    requiredBundleEntries: [
      "pan-api",
      "start.sh",
      "stop.sh",
      ".env.example",
      "frontend/dist/index.html"
    ]
  }
];

function normalizeTarEntry(entry) {
  const trimmed = entry.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.endsWith("/") ? trimmed : trimmed;
}

export function listTarEntries(tarPath) {
  const output = execFileSync("tar", ["-tzf", tarPath], { encoding: "utf8" });
  return new Set(
    output
      .split(/\r?\n/u)
      .map((entry) => normalizeTarEntry(entry))
      .filter(Boolean)
  );
}

export function findMissingBundleEntries(service, entries) {
  return service.requiredBundleEntries.filter((relativePath) => {
    const expectedPath = `${service.bundleTopLevelDir}/${relativePath}`;
    if (entries.has(expectedPath)) {
      return false;
    }
    const normalizedPrefix = expectedPath.endsWith("/") ? expectedPath : `${expectedPath}/`;
    return ![...entries].some((entry) => entry.startsWith(normalizedPrefix));
  });
}

export function validateBundleArchive(service, tarPath) {
  if (!fs.existsSync(tarPath)) {
    throw new Error(
      `missing builtin asset for ${service.id}: ${tarPath}\n` +
        `Please regenerate the upstream release bundle, for example:\n` +
        `cd /Users/linlay/Project/zenmind/${service.id} && make release-program`
    );
  }

  const entries = listTarEntries(tarPath);
  const missingEntries = findMissingBundleEntries(service, entries);
  if (missingEntries.length > 0) {
    throw new Error(
      `invalid builtin bundle for ${service.id}: ${tarPath}\n` +
        `Missing required entries: ${missingEntries.join(", ")}\n` +
        `Please regenerate the upstream release bundle, for example:\n` +
        `cd /Users/linlay/Project/zenmind/${service.id} && make release-program`
    );
  }
}

export function syncBuiltinAssets(projectRoot = process.cwd()) {
  const outputRoot = path.join(projectRoot, "build", "resources", "services");

  fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.mkdirSync(outputRoot, { recursive: true });

  const manifest = builtinServices.map((service) => {
    const sourcePath = path.join(service.sourceDir, service.assetFileName);
    validateBundleArchive(service, sourcePath);

    const serviceDir = path.join(outputRoot, service.id);
    fs.mkdirSync(serviceDir, { recursive: true });
    const outputTarPath = path.join(serviceDir, service.assetFileName);
    fs.copyFileSync(sourcePath, outputTarPath);
    validateBundleArchive(service, outputTarPath);

    return {
      id: service.id,
      version: service.version,
      assetFileName: service.assetFileName
    };
  });

  fs.writeFileSync(
    path.join(outputRoot, "manifest.json"),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), services: manifest }, null, 2)}\n`,
    "utf8"
  );

  return manifest;
}
