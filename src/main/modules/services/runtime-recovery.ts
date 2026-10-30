import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import { getService } from "./service-registry";
import { ensureBundleAssetHealthy, ensureDirectoryAssetHealthy } from "./manager/bundle-assets";
import { runExecFile, SERVICE_DEPLOY_TIMEOUT_MS } from "./manager/command-runner";
import { getServiceLayout } from "./manager/layout";
import { terminateProcessTree } from "./manager/process-cleanup";
import { extractArchiveToDir } from "../../support/archive/archive-utils";
import { readManifestFile, resolveCommand } from "../../support/manifest/manifest-utils";

// Freeze the current bundle, never an installed binary or a neighbouring repo.
// The service owns all interpretation of Platform data and configuration.
export async function preparePlatformRuntimeRecovery(app: App, transactionRoot: string, source: string, candidate: string) {
  const service = getService("agent-platform");
  if (!service || service.desktop.runtimeRecovery !== "v1") {
    throw new Error("Reinstallation requires an agent-platform bundle declaring desktop.runtimeRecovery=v1.");
  }
  const asset = ensureBundleAssetHealthy(app, service);
  const sourceConfigDir = getServiceLayout(app, service).configDir;
  const staging = path.join(transactionRoot, "platform-program");
  await fs.promises.mkdir(staging, { recursive: true, mode: 0o700 });
  let program: string;
  if (fs.statSync(asset).isDirectory()) {
    program = path.join(staging, service.desktop.bundleTopLevelDir ?? service.id);
    await fs.promises.cp(asset, program, { recursive: true, dereference: false });
  } else {
    await extractArchiveToDir(asset, staging);
    const entries = await fs.promises.readdir(staging);
    if (entries.length !== 1) throw new Error("Invalid Platform recovery bundle layout.");
    program = path.join(staging, entries[0]);
  }
  ensureDirectoryAssetHealthy(service, program, "Platform recovery");
  const manifest = readManifestFile(path.join(program, "manifest.json"));
  if (manifest.desktop?.runtimeRecovery !== "v1" || manifest.version !== service.version) {
    throw new Error("Platform recovery bundle contract/version mismatch.");
  }
  const sourceVersion = fs.readFileSync(path.join(source, "VERSION"), "utf8").trim().replace(/^v/u, "");
  const targetVersion = manifest.version.trim().replace(/^v/u, "");
  if (sourceVersion !== targetVersion) {
    throw new Error(`Unsupported runtime recovery: v${sourceVersion} -> v${targetVersion}; this bundle supports same-version recovery only.`);
  }
  const command = resolveCommand(manifest.lifecycle?.deploy);
  if (!command) throw new Error("Platform recovery bundle has no deploy command.");
  if (process.platform === "darwin") {
    await fs.promises.chmod(path.resolve(program, command[0]), 0o755);
  } else if (process.platform !== "win32") {
    throw new Error("Runtime recovery requires macOS or Windows.");
  }
  return async () => {
    try {
      for (const action of ["check", "restore"]) {
        const result = await runExecFile(command[0], [...command.slice(1),
          "--runtime-recovery-source", source, "--runtime-recovery-action", action,
          "--runtime-recovery-config-dir", sourceConfigDir,
          "--ap-runtime-dir", candidate
        ], program, { timeoutMs: action === "restore" ? 30 * 60_000 : SERVICE_DEPLOY_TIMEOUT_MS,
          onTimeout: pid => terminateProcessTree(pid) });
        await fs.promises.writeFile(path.join(transactionRoot, `platform-${action}.log`), result.stdout, { mode: 0o600 });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await fs.promises.writeFile(path.join(transactionRoot, "platform-error.log"), detail, { mode: 0o600 });
      throw new Error(`Platform recovery failed; original runtime is unchanged. Diagnostics: ${transactionRoot}\n${detail}`, { cause: error });
    }
    // The frozen executable is disposable after restoration; keep reports and
    // user backups, not another long-lived copy of the entire service bundle.
    await fs.promises.rm(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      .catch(error => console.warn("[runtime-recovery] retained temporary program", staging, error));
  };
}
