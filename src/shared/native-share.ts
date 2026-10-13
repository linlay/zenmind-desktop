import nativeShareProtocol from "./native-share-protocol.json";
import type {
  AgentWebclientNativeShareReadRequest,
  AgentWebclientNativeShareReadResult,
  AgentWebclientNativeShareTarget
} from "./contracts/agent-webclient-bridge";
import {
  AGENT_WEBCLIENT_NATIVE_SHARE_CHUNK_BYTES,
  AGENT_WEBCLIENT_NATIVE_SHARE_MAX_BYTES,
  AGENT_WEBCLIENT_NATIVE_SHARE_MAX_FILES
} from "./contracts/agent-webclient-bridge";

export const NATIVE_SHARE_READ_CHANNEL = "nativeShare.read";
export const NATIVE_SHARE_PROTOCOL_SCHEME = nativeShareProtocol.urlScheme;
export const NATIVE_SHARE_PROTOCOL_HOST = nativeShareProtocol.urlHost;
export const NATIVE_SHARE_TICKET_HEADER = nativeShareProtocol.ticketHeader;
export const NATIVE_SHARE_CHUNK_BYTES = AGENT_WEBCLIENT_NATIVE_SHARE_CHUNK_BYTES;
export const NATIVE_SHARE_MAX_BYTES = AGENT_WEBCLIENT_NATIVE_SHARE_MAX_BYTES;
export const NATIVE_SHARE_MAX_FILES = AGENT_WEBCLIENT_NATIVE_SHARE_MAX_FILES;

export type NativeShareTarget = AgentWebclientNativeShareTarget;
/** Main-only native handoff capability; it is never passed to a renderer or WebClient. */
export type NativeShareTransfer = { batchId: string; port: number; ticket: string };
export type NativeShareReadRequest = AgentWebclientNativeShareReadRequest;
export type NativeShareReadResult = AgentWebclientNativeShareReadResult;
export type NativeShareFileDescriptor = Extract<NativeShareReadResult, { files: unknown }>['files'][number];
export type NativeShareErrorCode = Extract<NativeShareReadResult, { ok: false }>['code'];

/** Native extension batch names are lowercase UUIDs, never filesystem paths. */
export function isNativeShareBatchId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
}
