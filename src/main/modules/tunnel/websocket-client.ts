import { EventEmitter } from "node:events";
import WebSocket from "ws";

export type TunnelHubWebSocketMessage = { type: number; payload: Buffer };
export type TunnelHubWebSocketClientOptions = {
  headers?: Record<string, string | string[]>;
  tlsInsecureSkipVerify?: boolean;
  timeoutMs?: number;
};

const MAX_WEBSOCKET_MESSAGE_BYTES = 64 << 20;

// ws owns RFC 6455. This adapter owns the Tunnel activation barrier and opcode contract.
export class TunnelHubWebSocketClient extends EventEmitter {
  private closed = false;
  private receiveStarted = false;
  private pending: TunnelHubWebSocketMessage[] = [];

  constructor(private readonly socket: WebSocket) {
    super();
    socket.binaryType = "nodebuffer";
    socket.on("message", (payload: Buffer, binary) => {
      if (this.closed) return;
      const message = { type: binary ? 2 : 1, payload };
      if (this.receiveStarted) this.emit("message", message);
      else this.pending.push(message);
    });
    socket.on("error", (error) => {
      this.pending = [];
      if (!this.closed) this.emit("error", error);
    });
    socket.on("close", () => {
      if (this.closed) return;
      this.closed = true;
      this.pending = [];
      this.emit("close");
    });
  }

  startReceiving() {
    if (this.closed || this.receiveStarted) return;
    this.receiveStarted = true;
    const pending = this.pending;
    this.pending = [];
    for (const message of pending) {
      if (this.closed) break;
      this.emit("message", message);
    }
    if (!this.closed) this.socket.resume();
  }

  sendMessage(type: number, payload: Buffer) {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) throw new Error("websocket is closed");
    if (type !== 1 && type !== 2) throw new Error(`unsupported websocket data opcode: ${type}`);
    if (payload.length > MAX_WEBSOCKET_MESSAGE_BYTES) throw new Error("websocket message too large");
    // A Buffer is also used for tunnel.open JSON; preserve its text opcode explicitly.
    this.socket.send(payload, { binary: type === 2, compress: false }, (error) => {
      if (error && !this.closed) this.emit("error", error);
    });
  }

  sendBinary(payload: Buffer) {
    this.sendMessage(2, payload);
  }

  close(code = 1000, reason = "") {
    if (this.closed) return;
    this.closed = true;
    this.pending = [];
    this.socket.resume();
    this.socket.close(code, reason);
  }

  destroy() {
    this.closed = true;
    this.pending = [];
    this.socket.terminate();
  }
}

export function connectTunnelHubWebSocket(
  url: string,
  options: TunnelHubWebSocketClientOptions = {}
): Promise<TunnelHubWebSocketClient> {
  return new Promise((resolve, reject) => {
    const socketOptions = {
      headers: options.headers,
      rejectUnauthorized: options.tlsInsecureSkipVerify !== true,
      handshakeTimeout: options.timeoutMs ?? 10_000,
      closeTimeout: 1_000,
      maxPayload: MAX_WEBSOCKET_MESSAGE_BYTES,
      // Retain the byte limit without imposing a new fragment/chunk count limit.
      maxFragments: 0,
      maxBufferedChunks: 0,
      perMessageDeflate: false,
      followRedirects: false
    };
    const socket = new WebSocket(url, socketOptions);
    const failed = (error: Error) => reject(error);
    const closed = () => reject(new Error("websocket closed during handshake"));
    socket.once("error", failed);
    socket.once("close", closed);
    socket.once("open", () => {
      socket.off("error", failed);
      socket.off("close", closed);
      // Upgrade and the first data frame can arrive in one TCP packet. pause alone
      // cannot stop ws's already buffered messages, so the adapter gates delivery.
      socket.pause();
      resolve(new TunnelHubWebSocketClient(socket));
    });
  });
}
