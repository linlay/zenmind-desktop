import {
  InitialEnvPackageSource,
  InitialEnvPackageRecord,
  ENV_INITIAL_PACKAGE_RELATIVE_PATH,
  ENV_INITIAL_MANIFEST_RELATIVE_PATH,
  InitialEnvPackageManifest,
  ENV_ZIP_FILE_NAME
} from "./runtime-env-contracts";
import { sha256Hex, writeFileModeBestEffort, normalizeVersion, toPosixRelativePath } from "./runtime-env-archive";
import path from "node:path";
import fs from "node:fs";

export async function persistInitialEnvPackage(input: {
  targetRoot: string;
  zipPath: string;
  zipBuffer: Buffer;
  source: InitialEnvPackageSource;
  desktopVersion: string;
}): Promise<InitialEnvPackageRecord> {
  const storedAt = new Date().toISOString();
  const sha256 = sha256Hex(input.zipBuffer);
  const packagePath = path.join(input.targetRoot, ENV_INITIAL_PACKAGE_RELATIVE_PATH);
  const manifestPath = path.join(input.targetRoot, ENV_INITIAL_MANIFEST_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(packagePath), { recursive: true });
  if (path.resolve(input.zipPath) !== path.resolve(packagePath)) {
    await fs.promises.writeFile(packagePath, input.zipBuffer);
  }
  writeFileModeBestEffort(packagePath, 0o600);
  const manifest: InitialEnvPackageManifest = {
    schemaVersion: 1,
    source: input.source,
    sourcePath: input.zipPath,
    desktopVersion: normalizeVersion(input.desktopVersion),
    sha256,
    size: input.zipBuffer.byteLength,
    storedAt,
    envZipRelativePath: ENV_ZIP_FILE_NAME
  };
  await fs.promises.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return {
    relativePath: toPosixRelativePath(ENV_INITIAL_PACKAGE_RELATIVE_PATH),
    manifestRelativePath: toPosixRelativePath(ENV_INITIAL_MANIFEST_RELATIVE_PATH),
    sha256,
    source: input.source,
    storedAt
  };
}
