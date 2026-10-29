import type { ShareCreateResult, ShareLimits, ShareReceiveRequest, ShareReceiveResult } from "../../shared/contracts/shares";

/** Main-only ports; these callbacks/bytes are never exposed by renderer IPC. */
export interface PreparedShare {
  manifest: Uint8Array;
  resources: Array<{ id: string; name: string; mimeType: string; bytes: Uint8Array }>;
  warning?: string;
}

/** Created by the owning business after its current instance is ready. */
export interface ShareReceiverEndpoint {
  readonly generation: string;
  isCurrent(): boolean;
  receive(request: ShareReceiveRequest, signal: AbortSignal): Promise<ShareReceiveResult>;
}
/** Only trusted Main modules register; no renderer registration IPC exists. */
export interface ShareReceiverRegistration {
  receiverId: string;
  owner: { type: "builtin" | "plugin" | "webapp"; id: string };
  contextVersions: readonly number[];
  activate(input: { intentId: string; signal: AbortSignal }): Promise<ShareReceiverEndpoint>;
}

export interface ShareServicePort {
  publish(prepare: (limits: ShareLimits) => Promise<PreparedShare | { ok: false; message: string }>): Promise<ShareCreateResult>;
  registerReceiver(registration: ShareReceiverRegistration): () => void;
}
