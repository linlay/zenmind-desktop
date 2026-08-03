import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import JSZip from "jszip";
import { getDataRoot, getDesktopConfigRoot } from "./user-paths";

const MAX_BUNDLE_SOURCE_BYTES = 12 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILE_COUNT = 120;
const SENSITIVE_KEY = /(?:access[_-]?token|api[_-]?key|authorization|client[_-]?secret|cookie|credential|jwt|password|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|token)/iu;

type BundleFile = {
  absolutePath: string;
  archivePath: string;
  kind: "config" | "log";
  sizeBytes: number;
};

export type EnterpriseChatSupportBundle = {
  filename: string;
  bytes: Buffer;
  includedFiles: string[];
  omittedFiles: string[];
};

function replaceAllLiteral(value: string, search: string, replacement: string) {
  return search ? value.split(search).join(replacement) : value;
}

function redactString(value: string, homePath: string, dataRoot: string) {
  let next = replaceAllLiteral(value, dataRoot, "$DESKTOP_DATA");
  next = replaceAllLiteral(next, homePath, "$HOME");
  next = next.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]");
  next = next.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED_JWT]");
  next = next.replace(
    /([?&](?:access_token|api_key|authorization|client_secret|password|refresh_token|secret|token)=)[^&#\s]+/giu,
    "$1[REDACTED]"
  );
  return next;
}

function redactJson(value: unknown, homePath: string, dataRoot: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactJson(item, homePath, dataRoot));
  }
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? redactString(value, homePath, dataRoot) : value;
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactJson(item, homePath, dataRoot)
  ]));
}

export function redactEnterpriseChatSupportText(
  content: string,
  homePath: string,
  dataRoot: string
) {
  const pathRedacted = redactString(content, homePath, dataRoot);
  try {
    return `${JSON.stringify(redactJson(JSON.parse(pathRedacted), homePath, dataRoot), null, 2)}\n`;
  } catch {
    return pathRedacted
      .replace(
        /((?:access[_-]?token|api[_-]?key|authorization|client[_-]?secret|cookie|credential|jwt|password|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|token)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
        "$1[REDACTED]"
      );
  }
}

function collectFiles(root: string, archivePrefix: string, kind: BundleFile["kind"]) {
  const files: BundleFile[] = [];
  if (!fs.existsSync(root)) {
    return files;
  }
  const visit = (directory: string, relativeDirectory: string, depth: number) => {
    if (depth > 4 || files.length >= MAX_FILE_COUNT) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (files.length >= MAX_FILE_COUNT) {
        break;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath, relativePath, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      try {
        const stat = fs.statSync(absolutePath);
        files.push({
          absolutePath,
          archivePath: path.posix.join(archivePrefix, relativePath.split(path.sep).join("/")),
          kind,
          sizeBytes: stat.size
        });
      } catch {
        // A disappearing diagnostic file is omitted from this best-effort bundle.
      }
    }
  };
  visit(root, "", 0);
  return files;
}

async function readBundleFile(file: BundleFile) {
  const readBytes = Math.min(file.sizeBytes, MAX_FILE_BYTES);
  if (readBytes <= 0) {
    return Buffer.alloc(0);
  }
  const handle = await fs.promises.open(file.absolutePath, "r");
  try {
    const buffer = Buffer.alloc(readBytes);
    const position = file.kind === "log" && file.sizeBytes > readBytes
      ? file.sizeBytes - readBytes
      : 0;
    const result = await handle.read(buffer, 0, readBytes, position);
    return buffer.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}

function safeAppVersion(app: App) {
  try {
    return app.getVersion();
  } catch {
    return "unknown";
  }
}

export async function createEnterpriseChatSupportBundle(
  app: App,
  platform: NodeJS.Platform
): Promise<EnterpriseChatSupportBundle> {
  const homePath = app.getPath("home");
  const dataRoot = getDataRoot(app, platform);
  const candidates = [
    ...collectFiles(getDesktopConfigRoot(app, platform), "config/desktop", "config"),
    ...collectFiles(path.join(dataRoot, "logs", "desktop"), "logs/desktop", "log")
  ];
  const zip = new JSZip();
  const includedFiles: string[] = [];
  const omittedFiles: string[] = [];
  let sourceBytes = 0;

  for (const file of candidates) {
    const allowedBytes = Math.min(file.sizeBytes, MAX_FILE_BYTES);
    if (sourceBytes + allowedBytes > MAX_BUNDLE_SOURCE_BYTES) {
      omittedFiles.push(file.archivePath);
      continue;
    }
    try {
      const bytes = await readBundleFile(file);
      const redacted = redactEnterpriseChatSupportText(
        bytes.toString("utf8"),
        homePath,
        dataRoot
      );
      zip.file(file.archivePath, redacted);
      includedFiles.push(file.archivePath);
      sourceBytes += bytes.length;
    } catch {
      omittedFiles.push(file.archivePath);
    }
  }

  const createdAt = new Date().toISOString();
  zip.file("manifest.json", `${JSON.stringify({
    schemaVersion: 1,
    createdAt,
    appVersion: safeAppVersion(app),
    platform,
    privacy: "Known credential fields, JWTs, authorization headers, URL tokens, and local roots are redacted.",
    scope: ["config/desktop", "logs/desktop"],
    includedFiles,
    omittedFiles,
    limits: {
      maxFileBytes: MAX_FILE_BYTES,
      maxSourceBytes: MAX_BUNDLE_SOURCE_BYTES,
      maxFileCount: MAX_FILE_COUNT
    }
  }, null, 2)}\n`);
  const timestamp = createdAt.replace(/[:.]/gu, "-");
  return {
    filename: `desktop-support-${timestamp}.zip`,
    bytes: await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
    includedFiles,
    omittedFiles
  };
}

export const enterpriseChatSupportBundleInternals = {
  MAX_BUNDLE_SOURCE_BYTES,
  MAX_FILE_BYTES,
  MAX_FILE_COUNT,
  SENSITIVE_KEY
};
