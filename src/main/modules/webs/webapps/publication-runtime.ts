import type { App } from "electron";
import { listPublishedWebappIds, syncPublishedWebappRoute } from "./publisher";
import { webappRuntime, type WebappRuntime } from "./runtime";
import { readWebappItems } from "./store";
import type { WebsIntegrationPorts } from "../integration-ports";

export async function restorePublishedWebapps(
  app: App,
  ports?: WebsIntegrationPorts,
  runtimeFacade: WebappRuntime = webappRuntime
) {
  const itemsById = new Map(
    readWebappItems(app, process.platform, ports).map((item) => [item.id, item])
  );
  for (const id of listPublishedWebappIds(app, ports)) {
    const item = itemsById.get(id);
    if (!item) {
      continue;
    }
    const runtime = runtimeFacade.getStatus(app, item.id);
    if (runtime?.status === "running" && runtime.webUrl) {
      await syncPublishedWebappRoute(app, item, runtime, ports);
      continue;
    }
    await runtimeFacade.start(app, item.id);
  }
}
