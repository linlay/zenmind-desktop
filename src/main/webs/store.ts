import type { App } from "electron";
import type { WebEntry } from "../../shared/contracts";
import { webappManager } from "./webapps/manager";
import { readWebsiteItems } from "./websites/store";

export function readWebItems(app: App): WebEntry[] {
  return [
    ...readWebsiteItems(app),
    ...webappManager.list(app)
  ].sort((a, b) => a.createdAt - b.createdAt || a.label.localeCompare(b.label, "zh-CN"));
}
