import type { App } from "electron";

export function createInstallerShutdownArgs(primaryArg: string, legacyArgs: readonly string[]) {
  return new Set<string>([
    primaryArg,
    ...legacyArgs
  ]);
}

export function hasInstallerShutdownArg(commandLine: string[], installerShutdownArgs: ReadonlySet<string>) {
  return commandLine.some((arg) => installerShutdownArgs.has(arg));
}

export function requestMainSingleInstanceLock(app: Pick<App, "requestSingleInstanceLock" | "exit">) {
  const gotSingleInstanceLock = app.requestSingleInstanceLock();
  if (!gotSingleInstanceLock) {
    app.exit(0);
  }
  return gotSingleInstanceLock;
}
