import type { IncomingMessage, ServerResponse } from "node:http";

/** Request body completion is normal; only an unfinished response close cancels work. */
export function createHttpRequestLifetime(req: IncomingMessage, res: ServerResponse) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const close = () => { if (!res.writableFinished) abort(); };
  req.once("aborted", abort);
  res.once("close", close);
  if (req.aborted || res.destroyed) abort();
  return { controller, signal: controller.signal, dispose() {
    req.removeListener("aborted", abort); res.removeListener("close", close);
  } };
}
