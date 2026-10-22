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
  private buffer: Buffer;
  private closed = false;
  private receiveStarted = false;
  private fragmentedMessage: { type: number; buffer: Buffer; length: number } | null = null;

  constructor(private readonly socket: net.Socket, initialData: Buffer = Buffer.alloc(0)) {
    super();
    this.buffer = initialData;
    socket.pause();
    socket.on("data", (chunk) => this.handleData(chunk));
    socket.on("close", () => this.handleClose());
    socket.on("end", () => this.handleClose());
    socket.on("error", (error) => {
      this.clearReceivedData();
      this.emit("error", error);
    });
  }

  startReceiving() {
    if (this.closed || this.receiveStarted) {
      return;
    }
    this.receiveStarted = true;
    this.handleData(Buffer.alloc(0));
    if (!this.closed) {
      this.socket.resume();
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
    this.clearReceivedData();
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
    this.clearReceivedData();
    this.socket.destroy();
  }

  private clearReceivedData() {
    this.buffer = Buffer.alloc(0);
    this.fragmentedMessage = null;
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
    if (chunk.byteLength > 0) {
      this.buffer = this.buffer.byteLength === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    }
    if (!this.receiveStarted) {
      return;
    }
    try {
      this.parseFrames();
    } catch (error) {
      this.clearReceivedData();
      try {
        this.emit("error", error);
      } finally {
        this.close(1002, "protocol error");
      }
    }
  }

  private parseFrames() {
    while (!this.closed && this.buffer.byteLength >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let payloadLength = second & 0x7f;
      let headerLength = 2;
      if (payloadLength === 126) {
        if (this.buffer.byteLength < 4) {
          break;
        }
        payloadLength = this.buffer.readUInt16BE(2);
        headerLength = 4;
      } else if (payloadLength === 127) {
        if (this.buffer.byteLength < 10) {
          break;
        }
        const longLength = this.buffer.readBigUInt64BE(2);
        if (longLength > BigInt(MAX_WEBSOCKET_FRAME_BYTES)) {
          throw new Error(`websocket frame too large: ${longLength.toString()}`);
        }
        payloadLength = Number(longLength);
        headerLength = 10;
      }
      if (opcode === 0x8 || opcode === 0x9 || opcode === 0xA) {
        if (!fin || payloadLength > 125) {
          throw new Error("invalid websocket control frame");
        }
      } else if (opcode === 0x0) {
        if (!this.fragmentedMessage) {
          throw new Error("unexpected websocket continuation frame");
        }
        if (this.fragmentedMessage.length + payloadLength > MAX_WEBSOCKET_FRAME_BYTES) {
          throw new Error("websocket message too large");
        }
      } else if (opcode === 0x1 || opcode === 0x2) {
        if (this.fragmentedMessage) {
          throw new Error("interleaved websocket data messages");
        }
      } else {
        throw new Error(`unsupported websocket opcode: ${opcode}`);
      }
      const maskLength = masked ? 4 : 0;
      const frameLength = headerLength + maskLength + payloadLength;
      if (frameLength > this.buffer.byteLength) {
        break;
      }
      let payload = this.buffer.subarray(headerLength + maskLength, frameLength);
      if (masked) {
        const mask = this.buffer.subarray(headerLength, headerLength + 4);
        payload = Buffer.from(payload);
        for (let index = 0; index < payload.byteLength; index += 1) {
          payload[index] ^= mask[index % 4];
        }
      }
      this.buffer = frameLength === this.buffer.byteLength ? Buffer.alloc(0) : this.buffer.subarray(frameLength);
      this.handleFrame(opcode, payload, fin);
    }
  }

  private appendFragment(payload: Buffer) {
    const message = this.fragmentedMessage!;
    const length = message.length + payload.byteLength;
    if (length > message.buffer.byteLength) {
      const capacity = Math.min(MAX_WEBSOCKET_FRAME_BYTES, Math.max(length, message.buffer.byteLength * 2));
      const buffer = Buffer.allocUnsafe(capacity);
      message.buffer.copy(buffer, 0, 0, message.length);
      message.buffer = buffer;
    }
    payload.copy(message.buffer, message.length);
    message.length = length;
  }

  private handleFrame(opcode: number, payload: Buffer, fin: boolean) {
    if (opcode === 0x1 || opcode === 0x2) {
      if (fin) {
        this.emit("message", { type: opcode, payload } satisfies TunnelHubWebSocketMessage);
      } else {
        this.fragmentedMessage = { type: opcode, buffer: Buffer.alloc(0), length: 0 };
        this.appendFragment(payload);
      }
      return;
    }
    if (opcode === 0x0) {
      this.appendFragment(payload);
      if (fin) {
        const message = this.fragmentedMessage!;
        this.fragmentedMessage = null;
        this.emit("message", {
          type: message.type,
          payload: message.buffer.subarray(0, message.length)
        } satisfies TunnelHubWebSocketMessage);
      }
      return;
    }
    if (opcode === 0x8) {
      this.closed = true;
      this.clearReceivedData();
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
  }

  private handleClose() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.clearReceivedData();
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
      cleanup();
      socket.destroy();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error("websocket handshake timed out")), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("connect", handleConnect);
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
      resolve(new TunnelHubWebSocketClient(socket, remaining));
    };
    const handleConnect = () => {
      socket.write(request);
    };
    socket.once("connect", handleConnect);
    socket.on("data", handleData);
    socket.on("error", handleError);
    socket.on("close", handleClose);
  });
}
