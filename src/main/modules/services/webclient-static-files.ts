import { AgentWebclientHostRecord, FrontendRequestResolution } from "./webclient-host-types";
import { parseRequestPath } from "./webclient-http-utils";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";

export function isSpaRoutePath(record: AgentWebclientHostRecord, requestPath: string) {
  return record.hosting.spaRoutePrefixes.some((routePath) =>
    requestPath === routePath || requestPath.startsWith(routePath)
  );
}

export function decodePathname(pathname: string) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

export function resolveFrontendRequest(record: AgentWebclientHostRecord, requestPath: string): FrontendRequestResolution {
  const normalizedPath = parseRequestPath(requestPath);
  if (normalizedPath === "/") {
    return { type: "file", filePath: record.indexFile };
  }

  const distRoot = path.resolve(record.frontendDist);
  const decodedPath = decodePathname(normalizedPath);
  const assetPath = path.resolve(record.frontendDist, `.${decodedPath}`);
  const isInsideDist = assetPath === distRoot || assetPath.startsWith(`${distRoot}${path.sep}`);

  if (isInsideDist && fs.existsSync(assetPath)) {
    const stats = fs.statSync(assetPath);
    if (stats.isFile()) {
      return { type: "file", filePath: assetPath };
    }
    if (stats.isDirectory()) {
      const nestedIndex = path.join(assetPath, "index.html");
      if (fs.existsSync(nestedIndex)) {
        return { type: "file", filePath: nestedIndex };
      }
    }
  }

  if (!record.frontendSpa) {
    return { type: "notFound" };
  }

  if (path.extname(normalizedPath) && !isSpaRoutePath(record, normalizedPath)) {
    return { type: "notFound" };
  }

  return { type: "file", filePath: record.indexFile };
}

export function contentTypeForFile(filePath: string) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

export function sendFile(req: http.IncomingMessage, res: http.ServerResponse, filePath: string) {
  const stats = fs.statSync(filePath);
  const basename = path.basename(filePath);
  res.writeHead(200, {
    "Content-Type": contentTypeForFile(filePath),
    "Content-Length": stats.size,
    "Cache-Control": basename === "conversation.template.html"
      ? "no-store"
      : basename === "index.html"
        ? "no-cache"
        : "public, max-age=31536000, immutable"
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  fs.createReadStream(filePath)
    .on("error", (error) => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      }
      res.end(error instanceof Error ? error.message : String(error));
    })
    .pipe(res);
}
