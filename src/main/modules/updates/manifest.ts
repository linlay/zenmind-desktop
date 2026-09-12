import type { DesktopUpdateManifest, DesktopUpdateArtifact } from "../../../shared/desktop-updates";
import { updateUrl } from "./config";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid update manifest object");
  return value as Record<string, unknown>;
}
// SemVer precedence, including prerelease identifiers; build metadata has no precedence.
function semver(value: unknown) {
  if (typeof value !== "string" || value.length > 128) throw new Error("Invalid update version");
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match) throw new Error("Invalid update version");
  const pre = match[4]?.split(".") ?? [];
  if (pre.some((id) => /^\d+$/.test(id) && id.length > 1 && id[0] === "0")) throw new Error("Invalid prerelease version");
  return { core: match.slice(1, 4).map(BigInt), pre };
}
export function compareUpdateVersions(left: string, right: string): number {
  const a = semver(left), b = semver(right);
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}
export function parseUpdateManifest(value: unknown, productId: string, channel: string): DesktopUpdateManifest {
  const input = record(value);
  if (input.schemaVersion !== 1 || input.productId !== productId || input.channel !== channel) throw new Error("Update manifest identity mismatch");
  semver(input.version);
  if (channel === "stable" && semver(input.version).pre.length) throw new Error("Stable feed contains a prerelease");
  if (typeof input.publishedAt !== "string" || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(input.publishedAt) || !Number.isFinite(Date.parse(input.publishedAt))) throw new Error("Invalid update publication time");
  const notes: Record<string, string[]> = {};
  for (const [locale, lines] of Object.entries(record(input.releaseNotes))) {
    if (!/^[a-z]{2}(?:-[A-Za-z]{2,8})?$/.test(locale) || !Array.isArray(lines) || lines.length > 100 || lines.some((line) => typeof line !== "string" || line.length > 2000)) throw new Error("Invalid update release notes");
    notes[locale] = lines;
  }
  const artifacts: Record<string, DesktopUpdateArtifact> = {};
  for (const [key, raw] of Object.entries(record(input.artifacts))) {
    if (!/^(darwin|win32)-(arm64|x64)$/.test(key)) throw new Error("Unsupported update artifact key");
    const item = record(raw);
    const url = updateUrl(item.url);
    if (!new URL(url).pathname.toLowerCase().endsWith(key.startsWith("darwin-") ? ".zip" : ".exe")) throw new Error("Wrong update artifact format");
    if (!Number.isSafeInteger(item.size) || (item.size as number) <= 0 || (item.size as number) > 16 * 1024 ** 3) throw new Error("Invalid update artifact size");
    if (typeof item.sha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(item.sha256)) throw new Error("Invalid update artifact checksum");
    artifacts[key] = { url, size: item.size as number, sha256: item.sha256.toLowerCase() };
  }
  return { schemaVersion: 1, productId, channel, version: input.version as string, publishedAt: input.publishedAt, releaseNotes: notes, artifacts };
}
