import type { EpochMilliseconds } from "../time-contract";

export const SHARE_PROTOCOL_VERSION = 1;
export const SHARE_MANAGEMENT_PATH = "/api/desktop/v2/shares";
export const SHARE_PUBLIC_PATH = "/share/";
export const SHARE_MANIFEST_PART = "manifest";
export const SHARE_RESOURCE_PART_PREFIX = "resource:";

export type ShareJson = null | boolean | number | string | ShareJson[] | { [key: string]: ShareJson };
export type ShareJsonObject = { [key: string]: ShareJson };
export type ShareAction = "preview" | "desktop" | "download" | "service";
export type ShareReadAction = ShareAction | "resolve";

/** Optional installed-package capability. The host derives receiverId from its owner. */
export interface ShareReceiverDeclaration {
  protocolVersion: 1;
  contextVersions: number[];
}

/** Optional source navigation hint. It grants no resource or identity access. */
export interface ShareSource {
  module: string;
  id: string;
}

export type ShareContent = { version: number } & (
  | { data: ShareJsonObject; resourceId?: never }
  | { resourceId: string; data?: never }
);

export interface ShareResource {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  /** Canonical relative POSIX path, only used by an explicit preview package. */
  path?: string;
}

export type SharePreview =
  | { type: "builtin"; viewer: "conversation"; entrypoint?: never }
  | { type: "package"; entrypoint: string; viewer?: never };

export interface ShareHandoff {
  receiverId: string;
  contextVersion: number;
  /** Opaque to the dispatcher. Validated by the exact registered business. */
  context: ShareJsonObject;
}

export interface ShareServiceBinding {
  type: "webapp";
  webAppId: string;
}

/** Main-only prepared content. Never send snapshots or bytes to ordinary renderer. */
export interface ShareEnvelope {
  protocolVersion: typeof SHARE_PROTOCOL_VERSION;
  kind: string;
  title: string;
  source?: ShareSource;
  content: ShareContent;
  resources: ShareResource[];
  preview?: SharePreview;
  desktop?: ShareHandoff;
  service?: ShareServiceBinding;
}

/** Metadata projection across IPC. Public HTTP strings are decoded in the client. */
export interface ShareRecord {
  id: string;
  kind: string;
  title: string;
  url: string;
  createdAt: EpochMilliseconds;
  lastAccessedAt: EpochMilliseconds | null;
  source?: ShareSource;
}

export interface ShareResolution {
  protocolVersion: typeof SHARE_PROTOCOL_VERSION;
  id: string;
  kind: string;
  title: string;
  actions: ShareAction[];
  desktop?: ShareHandoff;
}

export interface ShareLimits {
  maxManifestBytes: number;
  maxResourceBytes: number;
}

export type ShareCreateResult =
  | { ok: true; message: string; record: ShareRecord; warning?: string }
  | { ok: false; message: string };
export type ShareListResult =
  | { ok: true; message: string; records: ShareRecord[] }
  | { ok: false; message: string };
export type ShareRevokeResult =
  | { ok: true; message: string; shareId: string }
  | { ok: false; message: string };

/** Same transport retry keeps intentId; a new user opening gets a new intent. */
export interface ShareReceiveRequest extends ShareHandoff {
  intentId: string;
  shareId: string;
}

export type ShareReceiveResult =
  | { status: "received" }
  | { status: "unsupported" | "unavailable" | "invalid_context" };
