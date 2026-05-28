import { spawn } from "node:child_process";
import { isWindows } from "./detect.mjs";

export const npmCmd = isWindows() ? "npm.cmd" : "npm";

export function run(cmd, args, options = {}) {
  const {
    cwd,
    env = process.env,
    stdio = "inherit",
    shell = isWindows(),
    ...spawnOptions
  } = options;

  if (!cwd) {
    throw new Error("run() requires an explicit cwd option");
  }

  return spawn(cmd, args, {
    cwd,
    stdio,
    env,
    shell,
    ...spawnOptions
  });
}

export function runAndWait(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = run(cmd, args, options);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve(undefined);
        return;
      }
      reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code ?? -1}`));
    });
    child.once("error", reject);
  });
}
