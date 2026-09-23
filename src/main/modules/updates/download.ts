import https from "node:https";
import fs from "node:fs";
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import type { DesktopUpdateArtifact } from "../../../shared/desktop-updates";
import type { DesktopTestUpdateInput } from "../../../shared/desktop-updates";
import { updateUrl } from "./config";

export class UpdateHttpError extends Error {
  constructor(readonly status: number) { super(`Update server returned HTTP ${status}`); }
}

async function response(url: string, signal: AbortSignal, redirects = 0, platform?: NodeJS.Platform): Promise<{ stream: IncomingMessage; url: string }> {
  updateUrl(url);
  return new Promise((resolve, reject) => {
    const request = https.get(url, { signal, headers: {
      "Cache-Control": "no-cache", "Accept-Encoding": "identity",
      ...(platform ? { "X-Desktop-Platform": platform } : {}),
    } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
        res.resume();
        if (redirects >= 5 || !res.headers.location) return reject(new Error("Invalid update redirect"));
        try { resolve(response(updateUrl(new URL(res.headers.location, url).href), signal, redirects + 1, platform)); }
        catch (error) { reject(error); }
      } else if (res.statusCode === 200) resolve({ stream: res, url });
      else { res.resume(); reject(new UpdateHttpError(res.statusCode ?? 0)); }
    });
    request.setTimeout(30_000, () => request.destroy(Object.assign(new Error("Update request timed out"), { code: "ETIMEDOUT" })));
    request.on("error", reject);
  });
}
export async function fetchUpdateManifest(url: string, signal: AbortSignal, platform: NodeJS.Platform = "win32"): Promise<DesktopTestUpdateInput | undefined> {
  let result: Awaited<ReturnType<typeof response>>;
  const feed = new URL(updateUrl(url));
  feed.searchParams.set("platform", platform);
  try { result = await response(feed.href, signal, 0, platform); }
  catch (error) {
    // Only a missing manifest is normal; an artifact 404 remains a download error.
    if (error instanceof UpdateHttpError && error.status === 404) return undefined;
    throw error;
  }
  const manifest = await boundedText(result.stream, 256 * 1024);
  // macOS keeps the existing HTTPS feed; Squirrel.Mac validates the signed App.
  if (platform === "darwin") return { manifest, signature: "" };
  const signatureUrl = new URL(result.url);
  signatureUrl.pathname += ".sig";
  const signatureResponse = await response(signatureUrl.href, signal, 0, platform);
  const signature = await boundedText(signatureResponse.stream, 128);
  return { manifest, signature };
}
async function boundedText(res: IncomingMessage, limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res) {
    size += chunk.length;
    if (size > limit) { res.destroy(); throw new Error("Update metadata exceeds size limit"); }
    chunks.push(Buffer.from(chunk));
  }
  // Preserve BOM and reject malformed UTF-8 instead of replacing signed bytes.
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
}
export async function verifyUpdateFile(file: string, artifact: DesktopUpdateArtifact) {
  const stat = await fs.promises.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== artifact.size) throw new Error("Update size mismatch");
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  if (hash.digest("hex") !== artifact.sha256) throw new Error("Update checksum mismatch");
}
export async function downloadUpdateFile(artifact: DesktopUpdateArtifact, file: string, signal: AbortSignal, progress: (percent: number) => void) {
  const partial = file + ".part";
  await fs.promises.rm(partial, { force: true });
  try {
    const { stream: res } = await response(artifact.url, signal);
    let received = 0;
    let previous = -1;
    const meter = new Transform({ transform(chunk, _encoding, done) {
      received += chunk.length;
      if (received > artifact.size) return done(new Error("Update exceeds declared size"));
      const percent = Math.floor(received / artifact.size * 100);
      if (percent !== previous) { previous = percent; progress(percent); }
      done(null, chunk);
    } });
    await pipeline(res, meter, fs.createWriteStream(partial, { flags: "wx", mode: 0o600 }), { signal });
    await verifyUpdateFile(partial, artifact);
    await fs.promises.rename(partial, file);
  } finally { await fs.promises.rm(partial, { force: true }); }
}
