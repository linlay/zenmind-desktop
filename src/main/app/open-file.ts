import path from "node:path";
import { isSupportedDesktopDocumentPath } from "../../shared/local-document";

export { isSupportedDesktopDocumentPath } from "../../shared/local-document";

export function findDesktopDocumentPaths(
  commandLine: readonly string[],
  platform: NodeJS.Platform,
  workingDirectory: string,
): string[] {
  // Finder supplies open-file events, including on cold launch. Do not infer a
  // macOS document request from unrelated Electron command-line arguments.
  if (platform !== "win32") {
    return [];
  }

  const filePaths: string[] = [];
  for (const argument of commandLine.slice(1)) {
    const filePath = argument.startsWith('"') && argument.endsWith('"')
      ? argument.slice(1, -1)
      : argument;
    if (filePath.startsWith("-") || !isSupportedDesktopDocumentPath(filePath)) {
      continue;
    }
    // A drive prefix is a Windows path; every other URI scheme belongs to the
    // protocol handler and must never be opened as a local document.
    if (/^[a-z][a-z0-9+.-]*:/i.test(filePath) && !/^[a-z]:/i.test(filePath)) {
      continue;
    }
    filePaths.push(path.win32.resolve(workingDirectory, filePath));
  }
  return filePaths;
}
