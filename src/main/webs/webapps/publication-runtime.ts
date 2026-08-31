import type { App } from "electron";
import { listPublishedWebappIds, syncPublishedWebappRoute } from "./publisher";
import { webappRuntime } from "./runtime";
import { readWebappItems } from "./store";

export async function restorePublishedWebapps(app: App) {
  const itemsById = new Map(readWebappItems(app).map((item) => [item.id, item]));
  for (const id of listPublishedWebappIds(app)) {
    const item = itemsById.get(id);
    if (!item) {
      continue;
    }
    const runtime = webappRuntime.getStatus(app, item.id);
    if (runtime?.status === "running" && runtime.webUrl) {
      await syncPublishedWebappRoute(app, item, runtime);
      continue;
    }
    await webappRuntime.start(app, item.id);
  }
}
