import { createHash } from "node:crypto";
import type { App } from "electron";
import type { ShareEnvelope } from "../../../../shared/contracts/shares";
import type {
  PreparedShare,
  ShareServicePort,
} from "../../../support/share-ports";
import type { WebappEntry } from "../../../../shared/contracts";
import type { WebsIntegrationPorts } from "../integration-ports";
import { SHARE_INFO_PREVIEW } from "../../../support/share-info-preview";
import { t } from "../../../support/i18n/main-i18n";
import { readPublishedWebappBinding } from "./publisher";
import { readInstalledWebappItems } from "./store";

export function createPublishedWebappShare(
  app: App,
  shares: ShareServicePort,
  id: unknown,
  ports?: WebsIntegrationPorts,
) {
  if (typeof id !== "string" || !id || id.trim() !== id)
    return Promise.resolve({
      ok: false as const,
      message: t("webapp.notFound"),
    });
  return shares.publish(async (limits) => {
    const item = readInstalledWebappItems(app).find((item) => item.id === id);
    if (!item) return { ok: false, message: t("webapp.notFound") };
    const webAppId = await readPublishedWebappBinding(app, item, ports);
    const prepared = preparePublishedWebappShare(item, webAppId);
    if (prepared.manifest.byteLength > limits.maxManifestBytes)
      return { ok: false, message: t("assistant.chatShareSnapshotTooLarge") };
    if (
      prepared.resources.reduce(
        (total, resource) => total + resource.bytes.byteLength,
        0,
      ) > limits.maxResourceBytes
    )
      return { ok: false, message: t("assistant.chatShareResourcesTooLarge") };
    return prepared;
  });
}

/** Freeze only public presentation facts. The service stays bound to the current publication. */
export function preparePublishedWebappShare(
  item: WebappEntry,
  webAppId: string,
): PreparedShare {
  const data = Buffer.from(
    JSON.stringify({
      version: 1,
      context: {
        resourceVersion: item.version,
        display: {
          name: item.label,
          description: t("webapp.shareDescription", { version: item.version }),
          author: "",
          tags: [],
        },
      },
      labels: {
        type: t("webapp.shareType"),
        version: t("webapp.shareVersion"),
        author: "",
      },
    }),
    "utf8",
  );
  const resources = [
    {
      id: "000000000000000000000001",
      name: "index.html",
      mimeType: "text/html",
      path: "index.html",
      bytes: SHARE_INFO_PREVIEW,
    },
    {
      id: "000000000000000000000002",
      name: "data.json",
      mimeType: "application/json",
      path: "data.json",
      bytes: data,
    },
  ];
  const title =
    Buffer.byteLength(item.label) <= 255 && !/\p{Cc}/u.test(item.label)
      ? item.label
      : item.key;
  const envelope: ShareEnvelope = {
    protocolVersion: 1,
    kind: "webapp-service",
    title,
    ...(Buffer.byteLength(item.id) <= 255 && !/[\p{Cc}/\\:?#]/u.test(item.id)
      ? { source: { module: "webapp", id: item.id } }
      : {}),
    content: { version: 1, resourceId: resources[1].id },
    resources: resources.map(({ bytes, ...resource }) => ({
      ...resource,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })),
    preview: { type: "package", entrypoint: "index.html" },
    service: { type: "webapp", webAppId },
  };
  return { manifest: Buffer.from(JSON.stringify(envelope)), resources };
}
