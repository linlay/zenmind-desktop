import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { isWindows } from "./detect.mjs";

export const npmCmd = isWindows() ? "npm.cmd" : "npm";

function brandIdForEnv(brand) {
  const brandId = typeof brand === "string" ? brand : brand?.id;
  if (typeof brandId !== "string" || !brandId.trim()) {
    throw new Error("withBrandEnv requires a brand id");
  }
  return brandId;
}

export function withBrandEnv(brand, options = {}) {
  const brandId = brandIdForEnv(brand);
  return {
    ...options,
    env: {
      ...(options.env ?? process.env),
      BRAND: brandId
    }
  };
}

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
    const { onOutputLine, ...runOptions } = options;
    const child = run(cmd, args, onOutputLine
      ? { ...runOptions, stdio: ["inherit", "pipe", "pipe"] }
      : runOptions);
    if (onOutputLine) {
      let observerEnabled = true;
      for (const [stream, output] of [["stdout", child.stdout], ["stderr", child.stderr]]) {
        output.pipe(stream === "stdout" ? process.stdout : process.stderr, { end: false });
        const lines = createInterface({ input: output, crlfDelay: Infinity });
        lines.on("line", (line) => {
          if (!observerEnabled) return;
          try {
            onOutputLine(stream, line);
          } catch (error) {
            observerEnabled = false;
            console.warn(`[build-perf] output observer unavailable: ${error.message}`);
          }
        });
      }
    }
    let settled = false;
    const finish = (code) => {
      if (settled) {
        return;
      }
      settled = true;
      if (code === 0) {
        resolve(undefined);
        return;
      }
      reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code ?? -1}`));
    };
    if (!onOutputLine) child.once("exit", finish);
    child.once("close", finish);
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });
  });
}
