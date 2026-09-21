import { type Socket } from "node:net";
import http from "node:http";
import crypto from "node:crypto";
import { type DesktopWsConnection, type DesktopWsOutboundFrame } from "./ws-contracts";
import {
  DESKTOP_WS_NAMESPACE_DESKTOP,
  DESKTOP_WS_NAMESPACE_WEBAPP,
  DESKTOP_WS_NAMESPACE_AGENT_PLATFORM,
  type DesktopWsPushType
} from "../../../shared/desktop-ws";
import { readText } from "./ws-values";

export const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export const MAX_FRAME_BYTES = 1024 * 1024;

export function writeUpgradeFailure(socket: Socket, status: number, message: string) {
  if (socket.destroyed) {
    return;
  }
  const payload = Buffer.from(message, "utf8");
  try {
    socket.end(
      `HTTP/1.1 ${status} ${message}\r\n` +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${payload.byteLength}\r\n\r\n${message}`
    );
  } catch {
    socket.destroy();
  }
}

export function writeUpgradeSuccess(socket: Socket, req: http.IncomingMessage, subprotocol?: string) {
  const key = String(req.headers["sec-websocket-key"] ?? "");
  const accept = crypto.createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
  const headers = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`
  ];
  if (subprotocol) {
    headers.push(`Sec-WebSocket-Protocol: ${subprotocol}`);
  }
  socket.write(`${headers.join("\r\n")}\r\n\r\n`);
}

export function encodeWebSocketFrame(opcode: number, payload: Buffer) {
  const length = payload.byteLength;
  if (length < 126) {
    return Buffer.concat([Buffer.from([0x80 | opcode, length]), payload]);
  }
  if (length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, payload]);
}

export function sendJson(connection: DesktopWsConnection, payload: DesktopWsOutboundFrame) {
  if (connection.closed) {
    return;
  }
  connection.transport.sendText(JSON.stringify(payload));
}

export function sendResponse(
  connection: DesktopWsConnection,
  namespace: typeof DESKTOP_WS_NAMESPACE_DESKTOP | typeof DESKTOP_WS_NAMESPACE_WEBAPP,
  type: string,
  id: string,
  data: unknown,
  msg = "success"
) {
  sendJson(connection, { ns: namespace, frame: "response", type, id, code: 0, msg, data });
}

export function sendAgentPlatformError(connection: DesktopWsConnection, id: string | undefined, type: string, code: number, msg: string, data?: unknown) {
  sendJson(connection, { ns: DESKTOP_WS_NAMESPACE_AGENT_PLATFORM, frame: "error", type, id, code, msg, data });
}

export function withAgentPlatformNamespace(frame: Record<string, unknown>): DesktopWsOutboundFrame | null {
  const outboundFrame = readText(frame.frame);
  if (!outboundFrame || !["response", "push", "stream", "error"].includes(outboundFrame)) {
    return null;
  }
  const { ns: _ns, ...rest } = frame;
  return {
    ns: DESKTOP_WS_NAMESPACE_AGENT_PLATFORM,
    ...rest,
    frame: outboundFrame
  } as DesktopWsOutboundFrame;
}

export function sendError(
  connection: DesktopWsConnection,
  namespace: typeof DESKTOP_WS_NAMESPACE_DESKTOP | typeof DESKTOP_WS_NAMESPACE_WEBAPP,
  id: string | undefined,
  type: string,
  code: number,
  msg: string,
  data?: unknown
) {
  sendJson(connection, { ns: namespace, frame: "error", type, id, code, msg, data });
}

export function sendPush(connection: DesktopWsConnection, type: DesktopWsPushType | string, data?: unknown) {
  sendJson(connection, { ns: DESKTOP_WS_NAMESPACE_DESKTOP, frame: "push", type, data });
}

export function parseFrames(connection: DesktopWsConnection) {
  const messages: Array<{ opcode: number; payload: Buffer }> = [];
  let offset = 0;
  const buffer = connection.buffer;
  while (offset + 2 <= buffer.byteLength) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let payloadLength = second & 0x7f;
    let headerLength = 2;
    if (!fin) {
      throw new Error("fragmented websocket frames are not supported");
    }
    if (payloadLength === 126) {
      if (offset + 4 > buffer.byteLength) break;
      payloadLength = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (payloadLength === 127) {
      if (offset + 10 > buffer.byteLength) break;
      const longLength = buffer.readBigUInt64BE(offset + 2);
      if (longLength > BigInt(MAX_FRAME_BYTES)) {
        throw new Error("websocket frame is too large");
      }
      payloadLength = Number(longLength);
      headerLength = 10;
    }
    const maskLength = masked ? 4 : 0;
    const frameLength = headerLength + maskLength + payloadLength;
    if (offset + frameLength > buffer.byteLength) break;
    if (payloadLength > MAX_FRAME_BYTES) {
      throw new Error("websocket frame is too large");
    }
    let payload = buffer.subarray(offset + headerLength + maskLength, offset + frameLength);
    if (masked) {
      const mask = buffer.subarray(offset + headerLength, offset + headerLength + 4);
      payload = Buffer.from(payload);
      for (let index = 0; index < payload.byteLength; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }
    messages.push({ opcode, payload });
    offset += frameLength;
  }
  connection.buffer = buffer.subarray(offset);
  return messages;
}

export function closeSocketWithFrame(socket: Socket, code = 1000, reason = "closed") {
  if (socket.destroyed) {
    return;
  }
  const reasonBuffer = Buffer.from(reason, "utf8");
  const payload = Buffer.alloc(2 + reasonBuffer.byteLength);
  payload.writeUInt16BE(code, 0);
  reasonBuffer.copy(payload, 2);
  try {
    socket.end(encodeWebSocketFrame(0x8, payload));
  } catch {
    socket.destroy();
  }
}
