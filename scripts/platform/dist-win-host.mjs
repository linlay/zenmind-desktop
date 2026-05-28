import process from "node:process";
import { npmCmd, runAndWait } from "./spawn.mjs";

const projectRoot = process.cwd();

async function syncWindowsBuiltinAssets() {
  await runAndWait(npmCmd, ["run", "sync:assets", "--", "--os=windows", "--arch=amd64"], {
    cwd: projectRoot
  });
}

export async function buildOnWindowsHost() {
  await syncWindowsBuiltinAssets();
  await runAndWait(npmCmd, ["run", "build"], { cwd: projectRoot });
  await runAndWait(npmCmd, ["run", "stage:app", "--", "--os=win32", "--arch=x64"], {
    cwd: projectRoot
  });
  await runAndWait(npmCmd, ["exec", "electron-builder", "--", "--win", "--x64"], {
    cwd: projectRoot
  });
  await runAndWait(nodeBin(), ["./scripts/verify-win-package.mjs"], { cwd: projectRoot });
}

function nodeBin() {
  return process.execPath;
}
