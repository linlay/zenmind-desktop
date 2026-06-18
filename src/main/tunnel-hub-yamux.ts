import { EventEmitter } from "node:events";
import type { TunnelHubWebSocketClient, TunnelHubWebSocketMessage } from "./tunnel-hub-websocket-client";

const YAMUX_VERSION = 0;
const TYPE_DATA = 0;
const TYPE_WINDOW_UPDATE = 1;
const TYPE_PING = 2;
const TYPE_GOAWAY = 3;

const FLAG_SYN = 0x1;
const FLAG_ACK = 0x2;
const FLAG_FIN = 0x4;
const FLAG_RST = 0x8;

const INITIAL_STREAM_WINDOW = 256 * 1024;
const MAX_DATA_FRAME_BYTES = 64 * 1024;

type YamuxFrame = {
  type: number;
  flags: number;
  streamId: number;
  length: number;
  payload: Buffer<ArrayBufferLike>;
};

type ReadWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
};

type WindowWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
};

function encodeHeader(type: number, flags: number, streamId: number, length: number) {
  const header = Buffer.alloc(12);
  header[0] = YAMUX_VERSION;
  header[1] = type;
  header.writeUInt16BE(flags, 2);
  header.writeUInt32BE(streamId, 4);
  header.writeUInt32BE(length, 8);
  return header;
}

export class TunnelHubYamuxStream {
  private readBuffers: Buffer[] = [];
  private readBufferBytes = 0;
  private readWaiters: ReadWaiter[] = [];
  private windowWaiters: WindowWaiter[] = [];
  private remoteEnded = false;
  private closed = false;
  private remoteWindow = INITIAL_STREAM_WINDOW;

  constructor(
    readonly id: number,
    private readonly session: TunnelHubYamuxSession,
    initialRemoteWindow: number
  ) {
    if (initialRemoteWindow > 0) {
      this.remoteWindow = initialRemoteWindow;
    }
  }

  append(payload: Buffer) {
    if (this.closed || payload.byteLength === 0) {
      return;
    }
    this.readBuffers.push(payload);
    this.readBufferBytes += payload.byteLength;
    this.resolveReadWaiters();
  }

  markRemoteEnded() {
    this.remoteEnded = true;
    this.resolveReadWaiters();
  }

  updateRemoteWindow(increment: number) {
    if (increment <= 0) {
      return;
    }
    this.remoteWindow += increment;
    this.resolveWindowWaiters();
  }

  async readExactly(size: number) {
    if (size <= 0) {
      return Buffer.alloc(0);
    }
    const chunks: Buffer[] = [];
    let remaining = size;
    while (remaining > 0) {
      await this.waitForReadable(remaining);
      const chunk = this.readBuffers.shift();
      if (!chunk) {
        throw new Error("yamux stream closed before enough data was received");
      }
      if (chunk.byteLength <= remaining) {
        chunks.push(chunk);
        this.readBufferBytes -= chunk.byteLength;
        remaining -= chunk.byteLength;
        this.session.sendWindowUpdate(this.id, chunk.byteLength);
      } else {
        chunks.push(chunk.subarray(0, remaining));
        this.readBuffers.unshift(chunk.subarray(remaining));
        this.readBufferBytes -= remaining;
        this.session.sendWindowUpdate(this.id, remaining);
        remaining = 0;
      }
    }
    return Buffer.concat(chunks, size);
  }

  async write(payload: Buffer) {
    if (this.closed) {
      throw new Error("yamux stream is closed");
    }
    let offset = 0;
    while (offset < payload.byteLength) {
      await this.waitForRemoteWindow();
      const size = Math.min(MAX_DATA_FRAME_BYTES, this.remoteWindow, payload.byteLength - offset);
      if (size <= 0) {
        continue;
      }
      const chunk = payload.subarray(offset, offset + size);
      this.remoteWindow -= size;
      this.session.sendData(this.id, chunk);
      offset += size;
    }
  }

  end() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.session.sendFin(this.id);
    this.session.removeStream(this.id);
    this.rejectWaiters(new Error("yamux stream closed"));
  }

  reset() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.session.sendRst(this.id);
    this.session.removeStream(this.id);
    this.rejectWaiters(new Error("yamux stream reset"));
  }

  closeFromSession(error?: Error) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.rejectWaiters(error ?? new Error("yamux session closed"));
  }

  private async waitForReadable(size: number) {
    if (this.readBufferBytes >= size || this.readBufferBytes > 0) {
      return;
    }
    if (this.remoteEnded || this.closed) {
      throw new Error("yamux stream closed before data was available");
    }
    await new Promise<void>((resolve, reject) => {
      this.readWaiters.push({ resolve, reject });
    });
  }

  private async waitForRemoteWindow() {
    if (this.remoteWindow > 0) {
      return;
    }
    if (this.closed) {
      throw new Error("yamux stream is closed");
    }
    await new Promise<void>((resolve, reject) => {
      this.windowWaiters.push({ resolve, reject });
    });
  }

  private resolveReadWaiters() {
    const waiters = this.readWaiters.splice(0);
    for (const waiter of waiters) {
      waiter.resolve();
    }
  }

  private resolveWindowWaiters() {
    const waiters = this.windowWaiters.splice(0);
    for (const waiter of waiters) {
      waiter.resolve();
    }
  }

  private rejectWaiters(error: Error) {
    const readWaiters = this.readWaiters.splice(0);
    const windowWaiters = this.windowWaiters.splice(0);
    for (const waiter of [...readWaiters, ...windowWaiters]) {
      waiter.reject(error);
    }
  }
}

export class TunnelHubYamuxSession extends EventEmitter {
  private buffer = Buffer.alloc(0);
  private readonly streams = new Map<number, TunnelHubYamuxStream>();
  private closed = false;

  constructor(private readonly ws: TunnelHubWebSocketClient) {
    super();
    ws.on("message", (message: TunnelHubWebSocketMessage) => {
      if (message.type === 0x2) {
        this.handleBytes(message.payload);
      }
    });
    ws.on("close", () => this.closeFromSocket());
    ws.on("error", (error) => this.fail(error instanceof Error ? error : new Error(String(error))));
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.sendGoAway(0);
    this.ws.close(1000, "yamux closing");
    this.closeStreams(new Error("yamux session closed"));
    this.emit("close");
  }

  sendWindowUpdate(streamId: number, increment: number, flags = 0) {
    this.sendFrame(TYPE_WINDOW_UPDATE, flags, streamId, increment);
  }

  sendData(streamId: number, payload: Buffer<ArrayBufferLike>) {
    this.sendFrame(TYPE_DATA, 0, streamId, payload.byteLength, payload);
  }

  sendFin(streamId: number) {
    this.sendFrame(TYPE_DATA, FLAG_FIN, streamId, 0);
  }

  sendRst(streamId: number) {
    this.sendFrame(TYPE_WINDOW_UPDATE, FLAG_RST, streamId, 0);
  }

  removeStream(streamId: number) {
    this.streams.delete(streamId);
  }

  private handleBytes(chunk: Buffer) {
    if (this.closed) {
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      for (;;) {
        const frame = this.nextFrame();
        if (!frame) {
          return;
        }
        this.handleFrame(frame);
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private nextFrame(): YamuxFrame | null {
    if (this.buffer.byteLength < 12) {
      return null;
    }
    const version = this.buffer[0];
    if (version !== YAMUX_VERSION) {
      throw new Error(`unsupported yamux version: ${version}`);
    }
    const type = this.buffer[1];
    const flags = this.buffer.readUInt16BE(2);
    const streamId = this.buffer.readUInt32BE(4);
    const length = this.buffer.readUInt32BE(8);
    const payloadLength = type === TYPE_DATA ? length : 0;
    if (this.buffer.byteLength < 12 + payloadLength) {
      return null;
    }
    const payload = payloadLength > 0 ? this.buffer.subarray(12, 12 + payloadLength) : Buffer.alloc(0);
    this.buffer = this.buffer.subarray(12 + payloadLength);
    return { type, flags, streamId, length, payload };
  }

  private handleFrame(frame: YamuxFrame) {
    if (frame.type === TYPE_WINDOW_UPDATE && (frame.flags & FLAG_SYN) !== 0) {
      this.acceptStream(frame.streamId, frame.length);
      return;
    }
    if (frame.type === TYPE_WINDOW_UPDATE) {
      this.handleWindowUpdate(frame);
      return;
    }
    if (frame.type === TYPE_DATA) {
      this.handleDataFrame(frame);
      return;
    }
    if (frame.type === TYPE_PING) {
      if ((frame.flags & FLAG_SYN) !== 0) {
        this.sendFrame(TYPE_PING, FLAG_ACK, 0, frame.length);
      }
      return;
    }
    if (frame.type === TYPE_GOAWAY) {
      this.fail(new Error(`yamux goaway received: ${frame.length}`));
      return;
    }
    throw new Error(`unsupported yamux frame type: ${frame.type}`);
  }

  private acceptStream(streamId: number, remoteWindow: number) {
    if (this.streams.has(streamId)) {
      return;
    }
    const stream = new TunnelHubYamuxStream(streamId, this, remoteWindow);
    this.streams.set(streamId, stream);
    this.emit("stream", stream);
  }

  private handleWindowUpdate(frame: YamuxFrame) {
    const stream = this.streams.get(frame.streamId);
    if (!stream) {
      if ((frame.flags & FLAG_RST) === 0 && frame.streamId !== 0) {
        this.sendRst(frame.streamId);
      }
      return;
    }
    if ((frame.flags & FLAG_RST) !== 0) {
      this.streams.delete(frame.streamId);
      stream.closeFromSession(new Error("yamux stream reset by peer"));
      return;
    }
    stream.updateRemoteWindow(frame.length);
  }

  private handleDataFrame(frame: YamuxFrame) {
    const stream = this.streams.get(frame.streamId);
    if (!stream) {
      this.sendRst(frame.streamId);
      return;
    }
    if (frame.payload.byteLength > 0) {
      stream.append(frame.payload);
    }
    if ((frame.flags & FLAG_FIN) !== 0) {
      stream.markRemoteEnded();
    }
    if ((frame.flags & FLAG_RST) !== 0) {
      this.streams.delete(frame.streamId);
      stream.closeFromSession(new Error("yamux stream reset by peer"));
    }
  }

  private sendGoAway(code: number) {
    this.sendFrame(TYPE_GOAWAY, 0, 0, code);
  }

  private sendFrame(
    type: number,
    flags: number,
    streamId: number,
    length: number,
    payload: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  ) {
    if (this.closed && type !== TYPE_GOAWAY) {
      return;
    }
    const frame = Buffer.concat([encodeHeader(type, flags, streamId, length), payload]);
    this.ws.sendBinary(frame);
  }

  private closeFromSocket() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeStreams(new Error("tunnel websocket closed"));
    this.emit("close");
  }

  private fail(error: Error) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeStreams(error);
    this.ws.destroy();
    this.emit("error", error);
    this.emit("close");
  }

  private closeStreams(error: Error) {
    for (const stream of this.streams.values()) {
      stream.closeFromSession(error);
    }
    this.streams.clear();
  }
}
