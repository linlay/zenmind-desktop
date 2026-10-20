import type { WebEntryKey } from "./contracts/webs";
import { decodeRoutePathSegment, encodeRoutePathSegment } from "./route-path";

export function buildWebEntryPath(entryKey: string): string {
  // Keep the existing readable kind delimiter while encoding the opaque ID.
  return `/webs/${encodeRoutePathSegment(entryKey).replace(/%3A/gu, ":")}`;
}

export function resolveWebRouteEntryKey(pathname: string): WebEntryKey | null {
  const encodedEntryKey = /^\/webs\/([^/?#]+)\/*$/u.exec(pathname)?.[1];
  // Read the raw pathname: router params can turn a literal "%2F" ID into "/".
  const entryKey = decodeRoutePathSegment(encodedEntryKey);
  return entryKey && /^(?:website|webapp):[^/\\]+$/u.test(entryKey)
    ? entryKey as WebEntryKey
    : null;
}
