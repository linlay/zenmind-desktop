import fs from "node:fs";
import path from "node:path";

// Only Main supplies the runtime root; the artifact path comes from Platform.
export function resolveArtifactLocalFile(
  runtimeRoot: string,
  chatId: string,
  relativePath: string,
  platform: NodeJS.Platform,
  fileSystem: {
    realpathSync(target: string): string;
    statSync(target: string): Pick<fs.Stats, "isFile">;
  } = { realpathSync: fs.realpathSync.native, statSync: fs.statSync },
): string | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(chatId) || !relativePath.startsWith("artifacts/")) return null;
  const parts = relativePath.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /[\\\u0000-\u001f\u007f]/u.test(part))) return null;
  let pathApi: typeof path.posix;
  if (platform === "win32") {
    // Reject alternate data streams and Windows filename aliases.
    if (parts.some((part) => /[<>:"|?*]|[. ]$/u.test(part))) return null;
    pathApi = path.win32;
  } else if (platform === "darwin") {
    pathApi = path.posix;
  } else return null;
  try {
    const root = fileSystem.realpathSync(runtimeRoot);
    const chatRoot = pathApi.join(root, "chats", chatId);
    // A Chat directory must not alias another Chat, even inside the runtime.
    if (pathApi.relative(chatRoot, fileSystem.realpathSync(chatRoot))) return null;
    const target = fileSystem.realpathSync(pathApi.join(chatRoot, ...parts));
    const relative = pathApi.relative(chatRoot, target);
    if (!relative || relative === ".." || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative)) return null;
    return fileSystem.statSync(target).isFile() ? target : null;
  } catch { return null; }
}
