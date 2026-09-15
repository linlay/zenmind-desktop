import https from "node:https";
import fs from "node:fs";
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import type { DesktopUpdateArtifact } from "../../../shared/desktop-updates";
import { updateUrl } from "./config";

export class UpdateHttpError extends Error {
  constructor(readonly status: number) { super(`Update server returned HTTP ${status}`); }
}

async function response(url: string, signal: AbortSignal, redirects = 0): Promise<IncomingMessage> {
  updateUrl(url);
  return new Promise((resolve, reject) => {
    const request = https.get(url, { signal, headers: { "Cache-Control": "no-cache", "Accept-Encoding": "identity" } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
        res.resume();
        if (redirects >= 5 || !res.headers.location) return reject(new Error("Invalid update redirect"));
        try { resolve(response(updateUrl(new URL(res.headers.location, url).href), signal, redirects + 1)); }
        catch (error) { reject(error); }
      } else if (res.statusCode === 200) resolve(res);
      else { res.resume(); reject(new UpdateHttpError(res.statusCode ?? 0)); }
    });
    request.setTimeout(30_000, () => request.destroy(new Error("Update request timed out")));
    request.on("error", reject);
  });
}
export async function fetchUpdateManifest(url: string, signal: AbortSignal): Promise<unknown> {
  let res: IncomingMessage;
  try { res = await response(url, signal); }
  catch (error) {
    // Only a missing manifest is normal; an artifact 404 remains a download error.
    if (error instanceof UpdateHttpError && error.status === 404) return undefined;
    throw error;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res) {
    size += chunk.length;
    if (size > 256 * 1024) { res.destroy(); throw new Error("Update manifest exceeds size limit"); }
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
    const res = await response(artifact.url, signal);
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
