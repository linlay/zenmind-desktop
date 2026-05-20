import fs from "node:fs";
import { execFile } from "node:child_process";
import { shell } from "electron";

type ExecFile = typeof execFile;

type OpenUrlInChromeDeps = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execFile?: ExecFile;
  existsSync?: (path: string) => boolean;
  mkdirSync?: (path: string, options: { recursive: true }) => unknown;
  openExternal?: (url: string) => Promise<void>;
  userDataDir?: string;
};

type CommandSpec = {
  command: string;
  args: string[];
  requiresExistingFile?: boolean;
};

type ChromeLaunchOptions = {
  userDataDir?: string;
};

function execFileAsync(execFileImpl: ExecFile, command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    execFileImpl(command, args, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export function getChromeLaunchCandidates(
  url: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  options: ChromeLaunchOptions = {}
): CommandSpec[] {
  const chromeArgs = options.userDataDir
    ? [
      `--user-data-dir=${options.userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--new-window",
      url
    ]
    : [url];

  if (platform === "darwin") {
    if (options.userDataDir) {
      return [{
        command: "/usr/bin/open",
        args: ["-n", "-a", "Google Chrome", "--args", ...chromeArgs]
      }];
    }
    return [{ command: "/usr/bin/open", args: ["-a", "Google Chrome", url] }];
  }
  if (platform === "win32") {
    const candidates = [
      env.LOCALAPPDATA ? `${env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : "",
      env.PROGRAMFILES ? `${env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe` : "",
      env["PROGRAMFILES(X86)"] ? `${env["PROGRAMFILES(X86)"]}\\Google\\Chrome\\Application\\chrome.exe` : ""
    ].filter(Boolean);
    return candidates.map((command) => ({ command, args: chromeArgs, requiresExistingFile: true }));
  }
  return [
    { command: "google-chrome", args: chromeArgs },
    { command: "google-chrome-stable", args: chromeArgs },
    { command: "chromium", args: chromeArgs },
    { command: "chromium-browser", args: chromeArgs }
  ];
}

export async function openUrlInChrome(url: string, deps: OpenUrlInChromeDeps = {}) {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const execFileImpl = deps.execFile ?? execFile;
  const existsSync = deps.existsSync ?? fs.existsSync;
  const mkdirSync = deps.mkdirSync ?? fs.mkdirSync;
  const openExternal = deps.openExternal ?? ((targetUrl: string) => shell.openExternal(targetUrl));
  if (deps.userDataDir) {
    mkdirSync(deps.userDataDir, { recursive: true });
  }
  const candidates = getChromeLaunchCandidates(url, platform, env, { userDataDir: deps.userDataDir });

  for (const candidate of candidates) {
    if (candidate.requiresExistingFile && !existsSync(candidate.command)) {
      continue;
    }
    try {
      await execFileAsync(execFileImpl, candidate.command, candidate.args);
      return { ok: true, browser: "chrome" as const, command: candidate.command };
    } catch {
      // Try the next known Chrome location/name for this platform.
    }
  }

  await openExternal(url);
  return { ok: true, browser: "default" as const, command: "shell.openExternal" };
}
