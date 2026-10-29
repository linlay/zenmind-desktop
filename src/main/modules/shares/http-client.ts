import {
  SHARE_MANAGEMENT_PATH, SHARE_MANIFEST_PART, SHARE_PUBLIC_PATH, SHARE_RESOURCE_PART_PREFIX,
  type ShareLimits, type ShareRecord, type ShareResolution,
} from "../../../shared/contracts/shares";
import {
  ShareHttpError, ShareHttpTransport, authorizationHeaders, discardResponseBody,
  hasOnlyKeys, isRecord, isValidTunnelApiOrigin, readLimitedJson, readNullableRfc3339,
  readRequiredRfc3339, requireStatus, requireValidTarget, type ShareTarget,
} from "./http-transport";

import type { PreparedShare } from "../../support/share-ports";
export type { PreparedShare } from "../../support/share-ports";
const ID = /^[A-Za-z0-9_-]{1,80}$/u;
const LABEL = /^[a-z][a-z0-9._-]{0,127}$/u;
const READ_TIMEOUT = 10_000;

export class ShareHttpClient extends ShareHttpTransport {
  async limits(target: ShareTarget): Promise<ShareLimits> {
    requireValidTarget(target);
    const response = await this.request(target.origin + SHARE_MANAGEMENT_PATH + "/limits", {
      headers: authorizationHeaders(target), signal: target.signal, cache: "no-store",
    }, READ_TIMEOUT);
    await requireCurrentShareApi(response);
    await requireStatus(response, 200);
    const value = await readLimitedJson(response);
    if (!isRecord(value) || !hasOnlyKeys(value, ["maxManifestBytes", "maxResourceBytes"]) ||
        !positive(value.maxManifestBytes) || !positive(value.maxResourceBytes) ||
        !Number.isSafeInteger(value.maxManifestBytes + value.maxResourceBytes + 1024 * 1024)) invalid();
    return { maxManifestBytes: value.maxManifestBytes, maxResourceBytes: value.maxResourceBytes };
  }

  async create(target: ShareTarget, prepared: PreparedShare): Promise<ShareRecord> {
    requireValidTarget(target);
    if (!prepared.manifest.byteLength) throw new ShareHttpError("invalid_request");
    const form = new FormData();
    form.append(SHARE_MANIFEST_PART, new Blob([Uint8Array.from(prepared.manifest)], { type: "application/json" }), "manifest.json");
    for (const resource of prepared.resources) {
      form.append(SHARE_RESOURCE_PART_PREFIX + resource.id,
        new Blob([Uint8Array.from(resource.bytes)], { type: resource.mimeType }), resource.name);
    }
    const response = await this.request(target.origin + SHARE_MANAGEMENT_PATH, {
      method: "POST", headers: authorizationHeaders(target), signal: target.signal, body: form,
    }, 60_000);
    await requireCurrentShareApi(response);
    await requireStatus(response, 201);
    const record = readShareRecord(await readLimitedJson(response));
    if (record.lastAccessedAt !== null) invalid();
    return record;
  }

  async list(target: ShareTarget): Promise<ShareRecord[]> {
    requireValidTarget(target);
    const response = await this.request(target.origin + SHARE_MANAGEMENT_PATH, {
      headers: authorizationHeaders(target), signal: target.signal, cache: "no-store",
    }, READ_TIMEOUT);
    await requireCurrentShareApi(response);
    await requireStatus(response, 200);
    const value = await readLimitedJson(response);
    if (!isRecord(value) || !hasOnlyKeys(value, ["items"]) || !Array.isArray(value.items)) invalid();
    const seen = new Set<string>();
    return value.items.map((item) => {
      const record = readShareRecord(item);
      if (seen.has(record.id)) invalid();
      seen.add(record.id);
      return record;
    });
  }

  async revoke(target: ShareTarget, id: string): Promise<void> {
    requireValidTarget(target);
    if (id.trim() !== id || !ID.test(id)) throw new ShareHttpError("invalid_request");
    const response = await this.request(target.origin + SHARE_MANAGEMENT_PATH + "/" + id, {
      method: "DELETE", headers: authorizationHeaders(target), signal: target.signal,
    }, READ_TIMEOUT);
    await requireStatus(response, 204);
    await discardResponseBody(response);
  }

  async resolve(origin: string, id: string, signal?: AbortSignal): Promise<ShareResolution> {
    if (!isValidTunnelApiOrigin(origin) || id.trim() !== id || !ID.test(id)) throw new ShareHttpError("invalid_request");
    // Public resolution never carries the management bearer or a browser Cookie.
    const response = await this.request(origin + SHARE_PUBLIC_PATH + id + "?action=resolve", {
      cache: "no-store", signal,
    }, READ_TIMEOUT);
    await requireStatus(response, 200);
    return readShareResolution(await readLimitedJson(response), id);
  }
}

async function requireCurrentShareApi(response: Response) {
  if ([404, 405, 501].includes(response.status)) {
    await discardResponseBody(response);
    throw new ShareHttpError("rejected", response.status, "share_api_upgrade_required");
  }
}

export function readShareRecord(value: unknown): ShareRecord {
  if (!isRecord(value) || !only(value, ["id", "kind", "title", "url", "createdAt", "lastAccessedAt"], ["source"]) ||
      typeof value.id !== "string" || value.id.trim() !== value.id || !ID.test(value.id) || !label(value.kind) || !title(value.title) ||
      typeof value.url !== "string" || !safeShareURL(value.url, value.id)) invalid();
  const createdAt = readRequiredRfc3339(value.createdAt);
  const lastAccessedAt = readNullableRfc3339(value.lastAccessedAt);
  if (lastAccessedAt !== null && lastAccessedAt < createdAt) invalid();
  let source: ShareRecord["source"];
  if (value.source !== undefined) {
    if (!isRecord(value.source) || !hasOnlyKeys(value.source, ["module", "id"]) ||
        !label(value.source.module) || typeof value.source.id !== "string" || !value.source.id ||
        Buffer.byteLength(value.source.id) > 255 || /[\p{Cc}/\\:?#]/u.test(value.source.id)) invalid();
    source = { module: value.source.module, id: value.source.id };
  }
  return { id: value.id, kind: value.kind, title: value.title, url: value.url, createdAt, lastAccessedAt, ...(source ? { source } : {}) };
}

export function readShareResolution(value: unknown, id: string): ShareResolution {
  if (!isRecord(value) || !only(value, ["protocolVersion", "id", "kind", "title", "actions"], ["desktop"]) ||
      value.protocolVersion !== 1 || value.id !== id || !label(value.kind) || !title(value.title) ||
      !Array.isArray(value.actions) || new Set(value.actions).size !== value.actions.length ||
      value.actions.some((action) => !["preview", "desktop", "download", "service"].includes(action))) invalid();
  if (value.desktop !== undefined) {
    const handoff = value.desktop;
    if (!isRecord(handoff) || !hasOnlyKeys(handoff, ["receiverId", "contextVersion", "context"]) ||
        !label(handoff.receiverId) || !positive(handoff.contextVersion) || handoff.contextVersion > 2 ** 31 - 1 ||
        !isRecord(handoff.context) || !value.actions.includes("desktop")) invalid();
  } else if (value.actions.includes("desktop")) invalid();
  // The JSON came through a strict bounded decoder; context remains opaque here.
  return value as unknown as ShareResolution;
}

function only(value: Record<string, unknown>, required: string[], optional: string[]) {
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}
function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function label(value: unknown): value is string { return typeof value === "string" && value.trim() === value && LABEL.test(value); }
function title(value: unknown): value is string { return typeof value === "string" && Boolean(value.trim()) && Buffer.byteLength(value) <= 255 && !/\p{Cc}/u.test(value); }
function safeShareURL(value: string, id: string) {
  try { const url = new URL(value); return !url.username && !url.password && isValidTunnelApiOrigin(url.origin) && url.pathname === SHARE_PUBLIC_PATH + id && !url.search && !url.hash; } catch { return false; }
}
function invalid(): never { throw new ShareHttpError("invalid_response"); }
