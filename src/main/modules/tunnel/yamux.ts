import { EventEmitter } from "node:events";
import type { TunnelHubWebSocketClient, TunnelHubWebSocketMessage } from "./websocket-client";

const FRAME_OPEN = 1;
const FRAME_DATA = 2;
const FRAME_CLOSE = 3;

const FRAME_HEADER_BYTES = 13;
const MAX_FRAME_BYTES = 1 << 20;

// Matches tunnel-hub-server's local third_party/yamux replacement, not upstream yamux frames.
type TunnelHubFrame = {
  type: number;
  streamId: number;
  payload: Buffer<ArrayBufferLike>;
};

type ReadWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
};

function encodeHeader(type: number, streamId: number, size: number) {
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header[0] = type;
  header.writeBigUInt64BE(BigInt(streamId), 1);
  header.writeUInt32BE(size, 9);
  return header;
}

export class TunnelHubYamuxStream {
  private readBuffers: Buffer[] = [];
  private readBufferBytes = 0;
  private readWaiters: ReadWaiter[] = [];
  private remoteEnded = false;
  private closed = false;

  constructor(
    readonly id: number,
    private readonly session: TunnelHubYamuxSession
  ) {}

  append(payload: Buffer) {
    if (this.closed || payload.byteLength === 0) {
      return;
    }
    this.readBuffers.push(payload);
    this.readBufferBytes += payload.byteLength;
    this.resolveReadWaiters();
  }

  closeFromSession(error?: Error) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.remoteEnded = true;
    this.rejectWaiters(error ?? new Error("tunnel stream closed"));
  }

  async readExactly(size: number) {
    if (size <= 0) {
      return Buffer.alloc(0);
    }
    const chunks: Buffer[] = [];
    let remaining = size;
    while (remaining > 0) {
      await this.waitForReadable();
      const chunk = this.readBuffers.shift();
      if (!chunk) {
        throw new Error("tunnel stream closed before enough data was received");
      }
      if (chunk.byteLength <= remaining) {
        chunks.push(chunk);
        this.readBufferBytes -= chunk.byteLength;
        remaining -= chunk.byteLength;
      } else {
        chunks.push(chunk.subarray(0, remaining));
        this.readBuffers.unshift(chunk.subarray(remaining));
        this.readBufferBytes -= remaining;
        remaining = 0;
      }
    }
    return Buffer.concat(chunks, size);
  }

  async write(payload: Buffer) {
    if (this.closed) {
      throw new Error("tunnel stream is closed");
    }
    let offset = 0;
    while (offset < payload.byteLength) {
      const chunk = payload.subarray(offset, offset + MAX_FRAME_BYTES);
      this.session.sendData(this.id, chunk);
      offset += chunk.byteLength;
    }
  }

  end() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.remoteEnded = true;
    this.session.sendClose(this.id);
    this.session.removeStream(this.id);
    this.rejectWaiters(new Error("tunnel stream closed"));
  }

  reset() {
    this.end();
  }

  private async waitForReadable() {
    if (this.readBufferBytes > 0) {
      return;
    }
    if (this.remoteEnded || this.closed) {
      throw new Error("tunnel stream closed before data was available");
    }
    await new Promise<void>((resolve, reject) => {
      this.readWaiters.push({ resolve, reject });
    });
  }

  private resolveReadWaiters() {
    const waiters = this.readWaiters.splice(0);
    for (const waiter of waiters) {
      waiter.resolve();
    }
  }

  private rejectWaiters(error: Error) {
    const waiters = this.readWaiters.splice(0);
    for (const waiter of waiters) {
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
    this.closeStreams(new Error("tunnel session closed"));
    this.ws.close(1000, "tunnel session closing");
    this.emit("close");
  }

  sendData(streamId: number, payload: Buffer<ArrayBufferLike>) {
    this.sendFrame(FRAME_DATA, streamId, payload);
  }

  sendClose(streamId: number) {
    this.sendFrame(FRAME_CLOSE, streamId);
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

  private nextFrame(): TunnelHubFrame | null {
    if (this.buffer.byteLength < FRAME_HEADER_BYTES) {
      return null;
    }
    const type = this.buffer[0];
    const streamId64 = this.buffer.readBigUInt64BE(1);
    if (streamId64 > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`tunnel stream id is too large: ${streamId64.toString()}`);
    }
    const streamId = Number(streamId64);
    const size = this.buffer.readUInt32BE(9);
    if (size > MAX_FRAME_BYTES) {
      throw new Error(`tunnel frame too large: ${size}`);
    }
    if (this.buffer.byteLength < FRAME_HEADER_BYTES + size) {
      return null;
    }
    const payload = size > 0
      ? this.buffer.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + size)
      : Buffer.alloc(0);
    this.buffer = this.buffer.subarray(FRAME_HEADER_BYTES + size);
    return { type, streamId, payload };
  }

  private handleFrame(frame: TunnelHubFrame) {
    switch (frame.type) {
      case FRAME_OPEN:
        this.acceptStream(frame.streamId);
        return;
      case FRAME_DATA:
        this.handleDataFrame(frame);
        return;
      case FRAME_CLOSE:
        this.handleCloseFrame(frame.streamId);
        return;
      default:
        throw new Error(`unsupported tunnel frame type: ${frame.type}`);
    }
  }

  private acceptStream(streamId: number) {
    if (this.streams.has(streamId)) {
      return;
    }
    const stream = new TunnelHubYamuxStream(streamId, this);
    this.streams.set(streamId, stream);
    this.emit("stream", stream);
  }

  private handleDataFrame(frame: TunnelHubFrame) {
    const stream = this.streams.get(frame.streamId);
    if (!stream) {
      this.sendClose(frame.streamId);
      return;
    }
    stream.append(frame.payload);
  }

  private handleCloseFrame(streamId: number) {
    const stream = this.streams.get(streamId);
    if (!stream) {
      return;
    }
    this.streams.delete(streamId);
    stream.closeFromSession(new Error("tunnel stream closed by peer"));
  }

  private sendFrame(
    type: number,
    streamId: number,
    payload: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  ) {
    if (this.closed) {
      return;
    }
    if (payload.byteLength > MAX_FRAME_BYTES) {
      throw new Error(`tunnel frame too large: ${payload.byteLength}`);
    }
    this.ws.sendBinary(Buffer.concat([encodeHeader(type, streamId, payload.byteLength), payload]));
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
