import crypto from "node:crypto";
import net from "node:net";
import type { App } from "electron";
import type {
  AgentAuthIssueResult,
  AgentAuthRefreshReason,
  DesktopWsProbeFrame,
  DesktopWsProbeResult,
  IdentityAccessTokenInspection,
  TunnelDebugSnapshot
} from "../../../shared/contracts";
import {
  DESKTOP_WS_HOST,
  DESKTOP_WS_NAMESPACE_DESKTOP,
  DESKTOP_WS_PATH,
  DESKTOP_WS_PORT
} from "../../../shared/desktop-ws";

type IssueAccessToken = (app: App, reason: AgentAuthRefreshReason) => Promise<AgentAuthIssueResult>;

type DesktopWsProbeTarget = "localDebug";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const WS_PROBE_TIMEOUT_MS = 5000;
const WS_PROBE_TYPES = ["session.hello", "runtime.info"] as const;

function decodeJwtPart(part: string) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

function readStringClaim(payload: Record<string, unknown> | null, key: string) {
  const value = payload?.[key];
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).join(", ");
  }
  if (value === undefined || value === null) {
    return "";
  }
  return String(value);
}

function readJwtDate(payload: Record<string, unknown> | null, key: string) {
  const value = Number(payload?.[key]);
  if (!Number.isFinite(value) || value <= 0) {
    return "";
  }
  return new Date(value * 1000).toISOString();
}

function isExpired(payload: Record<string, unknown> | null) {
  const exp = Number(payload?.exp);
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 <= Date.now() : false;
}

export async function inspectIdentityAccessToken(
  app: App,
  issueAccessToken: IssueAccessToken,
  input?: { reason?: AgentAuthRefreshReason }
): Promise<IdentityAccessTokenInspection> {
  const reason = input?.reason === "unauthorized" ? "unauthorized" : "missing";
  const tokenResult = await issueAccessToken(app, reason);
  const token = tokenResult.token || "";
  let header: Record<string, unknown> | null = null;
  let payload: Record<string, unknown> | null = null;
  let parseError = "";

  if (token) {
    const parts = token.split(".");
    if (parts.length !== 3) {
      parseError = "Access token is not a JWT.";
    } else {
      try {
        header = decodeJwtPart(parts[0]);
        payload = decodeJwtPart(parts[1]);
      } catch (error) {
        parseError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  const ok = Boolean(tokenResult.ok && token && !parseError);
  return {
    ok,
    message: ok ? tokenResult.message : parseError || tokenResult.message || "Access token unavailable.",
    token,
    header,
    payload,
    claims: {
      subject: readStringClaim(payload, "sub"),
      issuer: readStringClaim(payload, "iss"),
      audience: readStringClaim(payload, "aud"),
      scope: readStringClaim(payload, "scope"),
      deviceId: readStringClaim(payload, "device_id") || readStringClaim(payload, "deviceId"),
      issuedAt: readJwtDate(payload, "iat"),
      expiresAt: readJwtDate(payload, "exp"),
      expired: isExpired(payload)
    },
    ...(parseError ? { parseError } : {})
  };
}

export function getTunnelDebugSnapshot(getStatus: () => TunnelDebugSnapshot["status"]): TunnelDebugSnapshot {
  return {
    status: getStatus(),
    capturedAt: new Date().toISOString()
  };
}

function createClientWebSocketFrame(payload: Buffer) {
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(payload.byteLength);
  for (let index = 0; index < payload.byteLength; index += 1) {
    masked[index] = payload[index] ^ mask[index % 4];
  }

  if (payload.byteLength < 126) {
    return Buffer.concat([Buffer.from([0x81, 0x80 | payload.byteLength]), mask, masked]);
  }
  if (payload.byteLength <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.byteLength, 2);
    return Buffer.concat([header, mask, masked]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 0x80 | 127;
  header.writeBigUInt64BE(BigInt(payload.byteLength), 2);
  return Buffer.concat([header, mask, masked]);
}

function createClientCloseFrame() {
  return Buffer.from([0x88, 0x80, 0, 0, 0, 0]);
}

function parseServerFrames(buffer: Buffer) {
  const messages: string[] = [];
  let offset = 0;
  while (buffer.byteLength - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (buffer.byteLength - offset < 4) {
        break;
      }
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (buffer.byteLength - offset < 10) {
        break;
      }
      const bigLength = buffer.readBigUInt64BE(offset + 2);
      if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("WebSocket frame is too large.");
      }
      length = Number(bigLength);
      headerLength = 10;
    }

    const maskLength = masked ? 4 : 0;
    const frameLength = headerLength + maskLength + length;
    if (buffer.byteLength - offset < frameLength) {
      break;
    }

    const payloadStart = offset + headerLength + maskLength;
    const payload = Buffer.from(buffer.subarray(payloadStart, payloadStart + length));
    if (masked) {
      const mask = buffer.subarray(offset + headerLength, offset + headerLength + 4);
      for (let index = 0; index < payload.byteLength; index += 1) {
        payload[index] = payload[index] ^ mask[index % 4];
      }
    }
    if (opcode === 0x1) {
      messages.push(payload.toString("utf8"));
    }
    offset += frameLength;
  }
  return {
    messages,
    remaining: Buffer.from(buffer.subarray(offset))
  };
}

function createProbeUrl(target: DesktopWsProbeTarget, token: string) {
  const port = DESKTOP_WS_PORT;
  const url = new URL(`ws://${DESKTOP_WS_HOST}:${port}${DESKTOP_WS_PATH}`);
  url.searchParams.set("token", token);
  url.searchParams.set("source", "desktop-debug-probe");
  return url.toString();
}

function createProbeDisplayUrl(target: DesktopWsProbeTarget) {
  const port = DESKTOP_WS_PORT;
  return `ws://${DESKTOP_WS_HOST}:${port}${DESKTOP_WS_PATH}`;
}

function createEmptyProbeFrame(requestType: typeof WS_PROBE_TYPES[number], message: string): DesktopWsProbeFrame {
  return {
    requestType,
    ok: false,
    frame: null,
    message
  };
}

function formatProbeFrame(requestType: typeof WS_PROBE_TYPES[number], frame: Record<string, unknown>): DesktopWsProbeFrame {
  const ok = frame.frame === "response" && frame.ns === DESKTOP_WS_NAMESPACE_DESKTOP && frame.type === requestType;
  return {
    requestType,
    ok,
    frame,
    message: ok
      ? "ok"
      : typeof frame.msg === "string"
        ? frame.msg
        : `unexpected frame: ${String(frame.frame || "unknown")}`
  };
}

async function runDesktopWsProbe(urlText: string): Promise<DesktopWsProbeFrame[]> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlText);
    const socket = net.createConnection({
      host: url.hostname,
      port: Number(url.port)
    });
    const key = crypto.randomBytes(16).toString("base64");
    const expectedAccept = crypto.createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
    let handshakeBuffer = Buffer.alloc(0);
    let wsBuffer = Buffer.alloc(0);
    let upgraded = false;
    let settled = false;
    const frames = new Map<string, DesktopWsProbeFrame>();
    const requestIds = new Map<string, typeof WS_PROBE_TYPES[number]>();

    const timer = setTimeout(() => {
      finish();
    }, WS_PROBE_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timer);
      socket.removeAllListeners();
      if (!socket.destroyed) {
        socket.end(createClientCloseFrame());
        socket.destroy();
      }
    }

    function finish(error?: Error) {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error) {
        reject(error);
        return;
      }
      resolve(WS_PROBE_TYPES.map((type) => frames.get(type) ?? createEmptyProbeFrame(type, "no response")));
    }

    function sendRequests() {
      for (const type of WS_PROBE_TYPES) {
        const id = `debug_probe_${type.replace(".", "_")}_${Date.now()}`;
        requestIds.set(id, type);
        const request = {
          ns: DESKTOP_WS_NAMESPACE_DESKTOP,
          frame: "request",
          type,
          id,
          payload: {}
        };
        socket.write(createClientWebSocketFrame(Buffer.from(JSON.stringify(request), "utf8")));
      }
    }

    function handleMessage(text: string) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return;
      }
      const requestId = typeof parsed.id === "string" ? parsed.id : "";
      const requestType = requestIds.get(requestId) ?? (WS_PROBE_TYPES.includes(parsed.type as any)
        ? parsed.type as typeof WS_PROBE_TYPES[number]
        : null);
      if (!requestType || frames.has(requestType)) {
        return;
      }
      frames.set(requestType, formatProbeFrame(requestType, parsed));
      if (WS_PROBE_TYPES.every((type) => frames.has(type))) {
        finish();
      }
    }

    socket.on("connect", () => {
      const requestPath = `${url.pathname}${url.search}`;
      socket.write([
        `GET ${requestPath} HTTP/1.1`,
        `Host: ${url.host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "\r\n"
      ].join("\r\n"));
    });
    socket.on("data", (chunk) => {
      try {
        if (!upgraded) {
          handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
          const headerEnd = handshakeBuffer.indexOf("\r\n\r\n");
          if (headerEnd === -1) {
            return;
          }
          const headersText = handshakeBuffer.subarray(0, headerEnd).toString("utf8");
          if (!/^HTTP\/1\.1 101\b/u.test(headersText)) {
            finish(new Error(headersText.split("\r\n")[0] || "WebSocket upgrade failed."));
            return;
          }
          const acceptHeader = headersText.split("\r\n").find((line) =>
            line.toLowerCase().startsWith("sec-websocket-accept:")
          );
          if (!acceptHeader || acceptHeader.split(":").slice(1).join(":").trim() !== expectedAccept) {
            finish(new Error("WebSocket upgrade returned an invalid accept header."));
            return;
          }
          upgraded = true;
          wsBuffer = handshakeBuffer.subarray(headerEnd + 4);
          handshakeBuffer = Buffer.alloc(0);
          sendRequests();
        } else {
          wsBuffer = Buffer.concat([wsBuffer, chunk]);
        }

        const parsed = parseServerFrames(wsBuffer);
        wsBuffer = parsed.remaining;
        for (const message of parsed.messages) {
          handleMessage(message);
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => finish());
  });
}

export async function probeDesktopWs(
  app: App,
  issueAccessToken: IssueAccessToken,
  input?: { target?: DesktopWsProbeTarget }
): Promise<DesktopWsProbeResult> {
  const target: DesktopWsProbeTarget = "localDebug";
  const displayUrl = createProbeDisplayUrl(target);
  const tokenResult = await issueAccessToken(app, "missing");
  if (!tokenResult.ok || !tokenResult.token.trim()) {
    return {
      ok: false,
      target,
      url: displayUrl,
      message: tokenResult.message || "Access token unavailable.",
      frames: []
    };
  }

  const url = createProbeUrl(target, tokenResult.token.trim());
  try {
    const frames = await runDesktopWsProbe(url);
    const ok = frames.length === WS_PROBE_TYPES.length && frames.every((frame) => frame.ok);
    return {
      ok,
      target,
      url: displayUrl,
      message: ok ? "ok" : "Desktop WS probe returned unexpected frames.",
      frames
    };
  } catch (error) {
    return {
      ok: false,
      target,
      url: displayUrl,
      message: error instanceof Error ? error.message : String(error),
      frames: WS_PROBE_TYPES.map((type) => createEmptyProbeFrame(type, "probe failed"))
    };
  }
}

export const __testInternals = {
  createClientWebSocketFrame,
  parseServerFrames
};
