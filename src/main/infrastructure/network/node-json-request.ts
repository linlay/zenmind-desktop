import http from "node:http";
import https from "node:https";

export class NodeJsonRequestError extends Error {
  constructor(readonly code: "response_too_large" | "connection_refused" | "network_error") { super(code); }
}

/** Dedicated sockets: long local calls never consume Chromium or a shared Agent's pool. */
export async function postNodeJson(url: string, options: {
  headers: Record<string, string>; body: string; signal: AbortSignal; maxResponseBytes: number;
}): Promise<Response> {
  options.signal.throwIfAborted();
  const target = new URL(url);
  if (target.protocol !== "http:" && target.protocol !== "https:") throw new NodeJsonRequestError("network_error");
  return new Promise((resolve, reject) => {
    const request = target.protocol === "https:" ? https.request : http.request;
    const req = request(target, { method: "POST", headers: options.headers, signal: options.signal, agent: false }, res => {
      const chunks: Buffer[] = []; let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > options.maxResponseBytes) {
          const error = new NodeJsonRequestError("response_too_large");
          reject(error); res.destroy(); req.destroy();
        } else chunks.push(chunk);
      });
      res.once("error", () => reject(options.signal.aborted ? options.signal.reason : new NodeJsonRequestError("network_error")));
      res.once("aborted", () => reject(options.signal.aborted ? options.signal.reason : new NodeJsonRequestError("network_error")));
      res.once("end", () => {
        try {
          const status = res.statusCode ?? 502;
          const headers = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) value.forEach(item => headers.append(key, item));
            else if (value !== undefined) headers.set(key, value);
          }
          resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers }));
        } catch (error) {
          // Node accepts status codes that Response rejects; event callbacks must reject, never throw into Main.
          reject(error);
        }
      });
    });
    req.setTimeout(0); // The caller's AbortSignal owns the full request deadline.
    req.once("error", (error: NodeJS.ErrnoException) => reject(options.signal.aborted ? options.signal.reason :
      new NodeJsonRequestError(error.code === "ECONNREFUSED" || error.code === "ENOTFOUND" ? "connection_refused" : "network_error")));
    req.end(options.body);
  });
}
