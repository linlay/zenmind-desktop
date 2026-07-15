import fs from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { APP_BRAND } from "../shared/brand";

export function getRendererEntry() {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    return devServerUrl;
  }
  const bundledEntry = path.join(__dirname, "..", "..", "dist-renderer", "index.html");
  if (fs.existsSync(bundledEntry)) {
    return bundledEntry;
  }
  const workspaceBuildEntry = path.join(
    process.cwd(),
    "build",
    "brands",
    APP_BRAND.id,
    "renderer",
    "index.html"
  );
  return fs.existsSync(workspaceBuildEntry) ? workspaceBuildEntry : bundledEntry;
}

export function getRendererRouteUrl(routePath: string) {
  const rendererEntry = getRendererEntry();
  if (process.env.VITE_DEV_SERVER_URL) {
    return `${rendererEntry.replace(/\/$/u, "")}/#${routePath}`;
  }
  return rendererEntry;
}

export function loadRendererRoute(targetWindow: BrowserWindow, routePath: string) {
  const rendererEntry = getRendererEntry();
  if (process.env.VITE_DEV_SERVER_URL) {
    return targetWindow.loadURL(getRendererRouteUrl(routePath));
  }
  return targetWindow.loadFile(rendererEntry, { hash: routePath });
}
