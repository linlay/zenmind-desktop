import type { App } from "electron";
import { listPublishedWebappIds } from "./publisher";
import { webappRuntime } from "./runtime";
import { readWebappItems } from "./store";

export async function restorePublishedWebapps(app: App) {
  const itemsById = new Map(readWebappItems(app).map((item) => [item.id, item]));
  for (const id of listPublishedWebappIds(app)) {
    const item = itemsById.get(id);
    if (!item) {
      continue;
    }
    await webappRuntime.start(app, item.id);
  }
}
