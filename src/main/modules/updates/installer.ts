import fs from "node:fs";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { autoUpdater } from "electron";

const logNativeError = (error: Error) => console.warn("[updates] native updater error", error);
const exec = promisify(execFile);
const psString = (value: string) => "'" + value.replace(/'/g, "''") + "'";

export async function verifyMacUpdateHost(executable: string) {
  const appPath = path.dirname(path.dirname(path.dirname(executable)));
  if (!appPath.endsWith(".app") || appPath.startsWith("/Volumes/")) throw new Error("Updates require an installed macOS app");
  await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath], { timeout: 60_000 });
  const { stderr } = await exec("/usr/bin/codesign", ["--display", "--verbose=4", appPath], { timeout: 15_000 });
  if (!/^TeamIdentifier=[A-Z0-9]+$/m.test(stderr)) throw new Error("Updates require a signed macOS release");
}

export async function verifyWindowsPublisher(file: string, currentExe: string) {
  const script = `$ErrorActionPreference='Stop'; $a=Get-AuthenticodeSignature -LiteralPath ${psString(currentExe)}; $b=Get-AuthenticodeSignature -LiteralPath ${psString(file)}; if ($a.Status -ne 'Valid' -or $b.Status -ne 'Valid' -or !$a.SignerCertificate -or !$b.SignerCertificate -or $a.SignerCertificate.Subject -ne $b.SignerCertificate.Subject) { throw 'Update publisher signature mismatch' }`;
  await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 60_000 });
}

/** Native Squirrel.Mac verifies the signed app and performs the actual replacement.
 * Call only AFTER coordinated cleanup: native staging can also install on a later quit.
 * No network feed or service credentials are exposed to the native updater.
 */
export async function installMacUpdate(file: string, version: string) {
  // Keep a diagnostic listener for late native errors, including after a timeout.
  // The native updater cannot be cancelled once staging has started.
  if (!autoUpdater.listeners("error").includes(logNativeError)) autoUpdater.on("error", logNativeError);
  const token = randomBytes(24).toString("hex");
  const size = (await fs.promises.stat(file)).size;
  let origin = "";
  const server = http.createServer((req, res) => {
    if (req.method !== "GET" || req.headers.host !== new URL(origin).host) { res.writeHead(404).end(); return; }
    if (req.url === `/${token}/feed`) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ url: `${origin}/${token}/update.zip`, name: version, notes: "" }));
    } else if (req.url === `/${token}/update.zip`) {
      res.writeHead(200, { "Content-Type": "application/zip", "Content-Length": size });
      const stream = fs.createReadStream(file);
      stream.on("error", () => res.destroy());
      res.on("close", () => stream.destroy());
      stream.pipe(res);
    } else res.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Update staging server unavailable");
  origin = `http://127.0.0.1:${address.port}`;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("Native update staging timed out")), 10 * 60_000);
      const finish = (error?: Error) => {
        clearTimeout(timer);
        autoUpdater.off("error", fail);
        autoUpdater.off("update-downloaded", success);
        autoUpdater.off("update-not-available", absent);
        error ? reject(error) : resolve();
      };
      const fail = (error: Error) => finish(error);
      const success = () => finish();
      const absent = () => finish(new Error("Native updater rejected the release"));
      autoUpdater.once("error", fail);
      autoUpdater.once("update-downloaded", success);
      autoUpdater.once("update-not-available", absent);
      try {
        autoUpdater.setFeedURL({ url: `${origin}/${token}/feed` });
        autoUpdater.checkForUpdates();
      } catch (error) { finish(error as Error); }
    });
    autoUpdater.quitAndInstall();
  } finally { server.closeAllConnections(); server.close(); }
}

export async function launchWindowsUpdate(file: string) {
  // Existing NSIS hooks verify the app/managed process exit and preserve its data root.
  const args = ["--updated", "/S", "--force-run"];
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true });
      child.once("error", reject);
      child.once("spawn", () => { child.unref(); resolve(); });
    });
  } catch (error) {
    if (!["EACCES", "EPERM", "UNKNOWN"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    // Per-machine NSIS installations require an explicit Windows elevation prompt.
    const script = `$ErrorActionPreference='Stop'; Start-Process -FilePath ${psString(path.resolve(file))} -ArgumentList '--updated','/S','--force-run' -Verb RunAs`;
    await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 120_000 });
  }
}
