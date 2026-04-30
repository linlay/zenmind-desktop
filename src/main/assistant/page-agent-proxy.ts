import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { AssistantSettingsPrivate } from "./settings-store";
import { normalizeOpenAIBaseURL } from "./model-provider";

type RegisteredSession = {
  settings: AssistantSettingsPrivate;
  createdAt: number;
};

export type PageAgentProxySession = {
  token: string;
  baseURL: string;
};

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-private-network": "true"
};

function readRequestBody(request: http.IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    request.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_REQUEST_BYTES) {
        reject(new Error("page-agent proxy request is too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendJson(response: http.ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    ...CORS_HEADERS
  });
  response.end(JSON.stringify(payload));
}

function sendPreflight(response: http.ServerResponse) {
  response.writeHead(204, CORS_HEADERS);
  response.end();
}

function bearerToken(request: http.IncomingMessage) {
  const authorization = String(request.headers.authorization || "");
  const match = authorization.match(/^Bearer\s+(.+)$/iu);
  return match?.[1]?.trim() || "";
}

export class PageAgentLLMProxy {
  private server: http.Server | null = null;
  private baseURL = "";
  private readonly sessions = new Map<string, RegisteredSession>();

  async register(settings: AssistantSettingsPrivate): Promise<PageAgentProxySession> {
    await this.ensureStarted();
    const token = `pa_${randomUUID()}`;
    this.sessions.set(token, {
      settings,
      createdAt: Date.now()
    });
    return {
      token,
      baseURL: this.baseURL
    };
  }

  revoke(token: string) {
    this.sessions.delete(token);
  }

  close() {
    this.sessions.clear();
    if (this.server) {
      this.server.close();
      this.server = null;
      this.baseURL = "";
    }
  }

  private async ensureStarted() {
    if (this.server && this.baseURL) {
      return;
    }

    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      const server = this.server;
      if (!server) {
        reject(new Error("page-agent proxy server was not created"));
        return;
      }
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        const address = server.address() as AddressInfo;
        this.baseURL = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse) {
    if (request.method === "OPTIONS") {
      sendPreflight(response);
      return;
    }

    if (request.method !== "POST" || request.url !== "/chat/completions") {
      sendJson(response, 404, { error: { message: "not found" } });
      return;
    }

    const session = this.sessions.get(bearerToken(request));
    if (!session) {
      sendJson(response, 401, { error: { message: "invalid page-agent proxy token" } });
      return;
    }

    try {
      const body = await readRequestBody(request);
      const upstream = await fetch(normalizeOpenAIBaseURL(session.settings.baseURL), {
        method: "POST",
        headers: {
          "content-type": request.headers["content-type"] || "application/json",
          authorization: `Bearer ${session.settings.apiKey}`
        },
        body
      });
      const responseBody = await upstream.text();
      response.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
        ...CORS_HEADERS
      });
      response.end(responseBody);
    } catch (error) {
      sendJson(response, 502, {
        error: {
          message: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }
}

export const __testInternals = {
  bearerToken,
  MAX_REQUEST_BYTES
};
