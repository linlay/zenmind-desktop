import path from "node:path";
import type { BrowserWindow } from "electron";

export function getRendererEntry() {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    return devServerUrl;
  }
  return path.join(__dirname, "..", "..", "dist-renderer", "index.html");
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
