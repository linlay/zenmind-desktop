import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import net from "node:net";
import tls from "node:tls";

type WebSocketHeaders = Record<string, string | string[]>;

export type TunnelHubWebSocketMessage = {
  type: number;
  payload: Buffer;
};

export type TunnelHubWebSocketClientOptions = {
  headers?: WebSocketHeaders;
  tlsInsecureSkipVerify?: boolean;
  timeoutMs?: number;
};

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_WEBSOCKET_FRAME_BYTES = 64 << 20;

function createSocket(parsed: URL, tlsInsecureSkipVerify: boolean) {
  const port = parsed.port ? Number.parseInt(parsed.port, 10) : parsed.protocol === "wss:" ? 443 : 80;
  if (parsed.protocol === "ws:") {
    return net.connect({ host: parsed.hostname, port });
  }
  if (parsed.protocol !== "wss:") {
    throw new Error(`unsupported websocket protocol: ${parsed.protocol}`);
  }

  const isWindows = process.platform === "win32";
  const isMac = process.platform === "darwin";
  const options: tls.ConnectionOptions = {
    host: parsed.hostname,
    port,
    servername: parsed.hostname,
    rejectUnauthorized: !tlsInsecureSkipVerify
  };
  if (isWindows) {
    return tls.connect(options);
  }
  if (isMac) {
    return tls.connect(options);
  }
  return tls.connect(options);
}

function parseHandshakeResponse(raw: string) {
  const [statusLine = "", ...lines] = raw.split("\r\n");
  const statusMatch = /^HTTP\/1\.[01]\s+(\d+)/u.exec(statusLine);
  const statusCode = statusMatch ? Number.parseInt(statusMatch[1], 10) : 0;
  const headers = new Map<string, string>();
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon <= 0) {
      continue;
    }
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return { statusCode, headers };
}

function websocketAccept(key: string) {
  return crypto
    .createHash("sha1")
    .update(`${key}${WS_GUID}`)
    .digest("base64");
}

function encodeClientFrame(opcode: number, payload: Buffer = Buffer.alloc(0)) {
  if (payload.byteLength > MAX_WEBSOCKET_FRAME_BYTES) {
    throw new Error(`websocket frame too large: ${payload.byteLength}`);
  }
  const payloadLength = payload.byteLength;
  const lengthBytes = payloadLength < 126 ? 0 : payloadLength <= 0xffff ? 2 : 8;
  const header = Buffer.alloc(2 + lengthBytes + 4);
  header[0] = 0x80 | opcode;
  if (payloadLength < 126) {
    header[1] = 0x80 | payloadLength;
  } else if (payloadLength <= 0xffff) {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payloadLength, 2);
  } else {
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payloadLength), 2);
  }
  const maskOffset = 2 + lengthBytes;
  const mask = crypto.randomBytes(4);
  mask.copy(header, maskOffset);
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.byteLength; index += 1) {
    masked[index] ^= mask[index % 4];
  }
  return Buffer.concat([header, masked]);
}

export class TunnelHubWebSocketClient extends EventEmitter {
  private buffer = Buffer.alloc(0);
  private closed = false;

  constructor(private readonly socket: net.Socket) {
    super();
    socket.on("data", (chunk) => this.handleData(chunk));
    socket.on("close", () => this.handleClose());
    socket.on("end", () => this.handleClose());
    socket.on("error", (error) => this.emit("error", error));
  }

  pushInitialData(chunk: Buffer) {
    if (chunk.byteLength > 0) {
      this.handleData(chunk);
    }
  }

  sendMessage(type: number, payload: Buffer) {
    this.writeFrame(type, payload);
  }

  sendBinary(payload: Buffer) {
    this.writeFrame(0x2, payload);
  }

  close(code = 1000, reason = "") {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const reasonBuffer = Buffer.from(reason, "utf8");
    const payload = Buffer.alloc(2 + reasonBuffer.byteLength);
    payload.writeUInt16BE(code, 0);
    reasonBuffer.copy(payload, 2);
    try {
      this.socket.end(encodeClientFrame(0x8, payload));
    } catch {
      this.socket.destroy();
    }
  }

  destroy() {
    this.closed = true;
    this.socket.destroy();
  }

  private writeFrame(opcode: number, payload: Buffer) {
    if (this.closed) {
      throw new Error("websocket is closed");
    }
    this.socket.write(encodeClientFrame(opcode, payload));
  }

  private handleData(chunk: Buffer) {
    if (this.closed) {
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      this.parseFrames();
    } catch (error) {
      this.emit("error", error);
      this.close(1002, "protocol error");
    }
  }

  private parseFrames() {
    let offset = 0;
    while (offset + 2 <= this.buffer.byteLength) {
      const first = this.buffer[offset];
      const second = this.buffer[offset + 1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let payloadLength = second & 0x7f;
      let headerLength = 2;
      if (!fin) {
        throw new Error("fragmented websocket frames are not supported");
      }
      if (payloadLength === 126) {
        if (offset + 4 > this.buffer.byteLength) {
          break;
        }
        payloadLength = this.buffer.readUInt16BE(offset + 2);
        headerLength = 4;
      } else if (payloadLength === 127) {
        if (offset + 10 > this.buffer.byteLength) {
          break;
        }
        const longLength = this.buffer.readBigUInt64BE(offset + 2);
        if (longLength > BigInt(MAX_WEBSOCKET_FRAME_BYTES)) {
          throw new Error(`websocket frame too large: ${longLength.toString()}`);
        }
        payloadLength = Number(longLength);
        headerLength = 10;
      }
      const maskLength = masked ? 4 : 0;
      const frameLength = headerLength + maskLength + payloadLength;
      if (offset + frameLength > this.buffer.byteLength) {
        break;
      }
      let payload = this.buffer.subarray(offset + headerLength + maskLength, offset + frameLength);
      if (payloadLength > MAX_WEBSOCKET_FRAME_BYTES) {
        throw new Error(`websocket frame too large: ${payloadLength}`);
      }
      if (masked) {
        const mask = this.buffer.subarray(offset + headerLength, offset + headerLength + 4);
        payload = Buffer.from(payload);
        for (let index = 0; index < payload.byteLength; index += 1) {
          payload[index] ^= mask[index % 4];
        }
      }
      this.handleFrame(opcode, payload);
      offset += frameLength;
    }
    this.buffer = this.buffer.subarray(offset);
  }

  private handleFrame(opcode: number, payload: Buffer) {
    if (opcode === 0x1 || opcode === 0x2) {
      this.emit("message", { type: opcode, payload } satisfies TunnelHubWebSocketMessage);
      return;
    }
    if (opcode === 0x8) {
      this.closed = true;
      this.socket.end();
      this.emit("close");
      return;
    }
    if (opcode === 0x9) {
      this.writeFrame(0xA, payload);
      return;
    }
    if (opcode === 0xA) {
      return;
    }
    throw new Error(`unsupported websocket opcode: ${opcode}`);
  }

  private handleClose() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.emit("close");
  }
}

export function connectTunnelHubWebSocket(
  rawUrl: string,
  options: TunnelHubWebSocketClientOptions = {}
): Promise<TunnelHubWebSocketClient> {
  const parsed = new URL(rawUrl);
  const key = crypto.randomBytes(16).toString("base64");
  const socket = createSocket(parsed, options.tlsInsecureSkipVerify === true);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const path = `${parsed.pathname || "/"}${parsed.search}`;
  const hostHeader = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  const headers = {
    Host: hostHeader,
    Upgrade: "websocket",
    Connection: "Upgrade",
    "Sec-WebSocket-Key": key,
    "Sec-WebSocket-Version": "13",
    ...(options.headers ?? {})
  };
  const headerLines = Object.entries(headers).flatMap(([name, value]) =>
    Array.isArray(value) ? value.map((item) => `${name}: ${item}`) : [`${name}: ${value}`]
  );
  const request = [
    `GET ${path} HTTP/1.1`,
    ...headerLines,
    "",
    ""
  ].join("\r\n");

  return new Promise((resolve, reject) => {
    let handshakeBuffer = Buffer.alloc(0);
    let settled = false;
    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error("websocket handshake timed out")), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", handleData);
      socket.off("error", handleError);
      socket.off("close", handleClose);
    };
    const handleError = (error: Error) => fail(error);
    const handleClose = () => fail(new Error("websocket closed during handshake"));
    const handleData = (chunk: Buffer) => {
      handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
      const headerEnd = handshakeBuffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }
      const rawHeaders = handshakeBuffer.subarray(0, headerEnd).toString("utf8");
      const remaining = handshakeBuffer.subarray(headerEnd + 4);
      const response = parseHandshakeResponse(rawHeaders);
      if (response.statusCode !== 101) {
        fail(new Error(`websocket upgrade failed with status ${response.statusCode || "unknown"}`));
        return;
      }
      const accept = response.headers.get("sec-websocket-accept") ?? "";
      if (accept !== websocketAccept(key)) {
        fail(new Error("websocket upgrade returned an invalid accept key"));
        return;
      }
      settled = true;
      cleanup();
      const client = new TunnelHubWebSocketClient(socket);
      client.pushInitialData(remaining);
      resolve(client);
    };
    socket.once("connect", () => {
      socket.write(request);
    });
    socket.on("data", handleData);
    socket.on("error", handleError);
    socket.on("close", handleClose);
  });
}
