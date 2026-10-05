import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import { listUserDesktopPets } from "./pet-assets";
import { getDesktopPetsDataRoot } from "../../infrastructure/filesystem/user-paths";

// Resolve IDs from the installed catalog, never accept a renderer-supplied path.
export function resolveRemovablePetPath(app: App, appearanceId: unknown): string {
  if (typeof appearanceId !== "string" || !/^user:[a-z0-9][a-z0-9._-]*$/u.test(appearanceId))
    throw new Error("Only installed user pets can be removed.");
  const matches = listUserDesktopPets(app).filter(pet => pet.id === appearanceId);
  if (matches.length !== 1) throw new Error("Installed pet not found or ambiguous.");
  const target = matches[0].rootPath;
  const stat = fs.lstatSync(target);
  const root = fs.realpathSync(getDesktopPetsDataRoot(app));
  if (!stat.isDirectory() || stat.isSymbolicLink() || path.dirname(fs.realpathSync(target)) !== root)
    throw new Error("Pet directory is outside the installed resource root.");
  return target;
}
