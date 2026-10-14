import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";

/**
 * Restricts a secrets directory to the current user. The vault is ciphertext either way;
 * this is the second line of defence, so the platform mechanisms are explicit.
 */
export function restrictDirectoryToCurrentUser(directory: string, platform: NodeJS.Platform = process.platform) {
  if (platform === "win32") {
    // POSIX modes are not enforced on Windows: drop inherited entries and grant only the current user.
    const { username } = os.userInfo();
    const principal = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${username}` : username;
    execFileSync("icacls", [directory, "/inheritance:r", "/grant:r", `${principal}:(OI)(CI)F`], { stdio: "ignore", windowsHide: true });
    return;
  }
  if (platform === "darwin") {
    fs.chmodSync(directory, 0o700);
    return;
  }
  fs.chmodSync(directory, 0o700);
}
