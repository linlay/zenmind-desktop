import type { App } from "electron";
import type { WebEntry } from "../../shared/contracts";
import { readWebappItems } from "./webapp-store";
import { readWebsiteItems } from "./website-store";

export function readWebItems(app: App): WebEntry[] {
  return [
    ...readWebsiteItems(app),
    ...readWebappItems(app)
  ].sort((a, b) => a.createdAt - b.createdAt || a.label.localeCompare(b.label, "zh-CN"));
}
