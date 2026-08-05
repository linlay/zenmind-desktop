import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { EnterpriseChatDesktopActionStatus } from "../shared/contracts";

const LEDGER_SCHEMA_VERSION = 2;
const MAX_DELIVERED_ENTRIES = 1_000;
const VALID_STATUSES = new Set<EnterpriseChatDesktopActionStatus>([
  "succeeded",
  "failed",
  "declined",
  "expired",
  "unsupported"
]);

export type EnterpriseChatActionLedgerEntry = {
  scope: string;
  messageId: string;
  requestId: string;
  conversationId: string;
  targetDeviceId: string;
  action: string;
  phase: "executing" | "terminal";
  status?: EnterpriseChatDesktopActionStatus;
  resultMessage: string;
  fileIds: string[];
  completedAt: number;
  deliveryState: "pending" | "delivered";
  updatedAt: number;
};

type LedgerFile = {
  schemaVersion: 2;
  legacyMessageIds: string[];
  entries: EnterpriseChatActionLedgerEntry[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(value: unknown, maxLength = 1_000) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function readEntry(value: unknown): EnterpriseChatActionLedgerEntry | null {
  const record = isRecord(value) ? value : {};
  const scope = readText(record.scope, 128);
  const messageId = readText(record.messageId, 128);
  const requestId = readText(record.requestId, 128);
  const conversationId = readText(record.conversationId, 128);
  const targetDeviceId = readText(record.targetDeviceId, 128);
  const action = readText(record.action, 256);
  const phase = record.phase === "executing" || record.phase === "terminal"
    ? record.phase
    : null;
  const status = typeof record.status === "string" && VALID_STATUSES.has(
    record.status as EnterpriseChatDesktopActionStatus
  )
    ? record.status as EnterpriseChatDesktopActionStatus
    : undefined;
  if (!scope || !messageId || !requestId || !conversationId || !targetDeviceId || !action || !phase) {
    return null;
  }
  if (phase === "terminal" && !status) {
    return null;
  }
  return {
    scope,
    messageId,
    requestId,
    conversationId,
    targetDeviceId,
    action,
    phase,
    ...(status ? { status } : {}),
    resultMessage: readText(record.resultMessage),
    fileIds: Array.isArray(record.fileIds)
      ? record.fileIds.map((item) => readText(item, 256)).filter(Boolean).slice(0, 20)
      : [],
    completedAt: Math.max(0, Math.trunc(Number(record.completedAt) || 0)),
    deliveryState: record.deliveryState === "delivered" ? "delivered" : "pending",
    updatedAt: Math.max(0, Math.trunc(Number(record.updatedAt) || 0))
  };
}

function ledgerKey(scope: string, requestId: string) {
  return `${scope}:${requestId}`;
}

export function enterpriseChatActionScope(
  serverUrl: string,
  userId: string,
  deviceId: string
) {
  return createHash("sha256")
    .update(JSON.stringify([serverUrl, userId, deviceId]))
    .digest("hex");
}

export class EnterpriseChatActionLedger {
  private readonly legacyMessageIds = new Set<string>();
  private readonly entries = new Map<string, EnterpriseChatActionLedgerEntry>();

  constructor(private readonly filePath: string) {
    this.read();
  }

  hasLegacyMessage(messageId: string) {
    return this.legacyMessageIds.has(messageId);
  }

  find(scope: string, requestId: string) {
    return this.entries.get(ledgerKey(scope, requestId));
  }

  claim(input: Omit<EnterpriseChatActionLedgerEntry,
    "phase" | "status" | "resultMessage" | "fileIds" | "completedAt" | "deliveryState" | "updatedAt"
  >) {
    const key = ledgerKey(input.scope, input.requestId);
    const existing = this.entries.get(key);
    if (existing) {
      return { created: false, entry: existing };
    }
    const entry: EnterpriseChatActionLedgerEntry = {
      ...input,
      phase: "executing",
      resultMessage: "",
      fileIds: [],
      completedAt: 0,
      deliveryState: "pending",
      updatedAt: Date.now()
    };
    this.entries.set(key, entry);
    if (!this.persist()) {
      this.entries.delete(key);
      throw new Error("Desktop action idempotency state could not be saved.");
    }
    return { created: true, entry };
  }

  complete(
    scope: string,
    requestId: string,
    input: {
      status: EnterpriseChatDesktopActionStatus;
      resultMessage: string;
      fileIds?: string[];
      completedAt?: number;
      delivered?: boolean;
    }
  ) {
    const entry = this.find(scope, requestId);
    if (!entry) {
      throw new Error("Desktop action idempotency state is missing.");
    }
    Object.assign(entry, {
      phase: "terminal" as const,
      status: input.status,
      resultMessage: input.resultMessage.slice(0, 1_000),
      fileIds: (input.fileIds ?? []).slice(0, 20),
      completedAt: input.completedAt ?? Date.now(),
      deliveryState: input.delivered ? "delivered" as const : "pending" as const,
      updatedAt: Date.now()
    });
    this.persist();
    return entry;
  }

  recordDelivered(input: Omit<EnterpriseChatActionLedgerEntry, "phase" | "deliveryState" | "updatedAt"> & {
    status: EnterpriseChatDesktopActionStatus;
  }) {
    const key = ledgerKey(input.scope, input.requestId);
    const existing = this.entries.get(key);
    const entry: EnterpriseChatActionLedgerEntry = {
      ...(existing ?? input),
      ...input,
      phase: "terminal",
      deliveryState: "delivered",
      updatedAt: Date.now()
    };
    this.entries.set(key, entry);
    this.persist();
    return entry;
  }

  recoverExecuting(scope: string) {
    const recovered: EnterpriseChatActionLedgerEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.scope !== scope || entry.phase !== "executing") {
        continue;
      }
      Object.assign(entry, {
        phase: "terminal" as const,
        status: "failed" as const,
        resultMessage: "Desktop restarted while this action was executing. Its outcome is unknown, so it was not retried.",
        fileIds: [],
        completedAt: Date.now(),
        deliveryState: "pending" as const,
        updatedAt: Date.now()
      });
      recovered.push(entry);
    }
    if (recovered.length > 0) {
      this.persist();
    }
    return recovered;
  }

  pendingReceipts(scope: string) {
    return [...this.entries.values()]
      .filter((entry) =>
        entry.scope === scope &&
        entry.phase === "terminal" &&
        entry.deliveryState === "pending"
      )
      .sort((left, right) => left.updatedAt - right.updatedAt);
  }

  markDelivered(scope: string, requestId: string) {
    const entry = this.find(scope, requestId);
    if (!entry || entry.phase !== "terminal") {
      return;
    }
    entry.deliveryState = "delivered";
    entry.updatedAt = Date.now();
    this.persist();
  }

  private read() {
    try {
      const value = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown;
      if (!isRecord(value)) {
        return;
      }
      const oldIds = Array.isArray(value.messageIds) ? value.messageIds : [];
      const legacyIds = Array.isArray(value.legacyMessageIds) ? value.legacyMessageIds : [];
      for (const id of [...oldIds, ...legacyIds]) {
        const normalized = readText(id, 128);
        if (normalized) {
          this.legacyMessageIds.add(normalized);
        }
      }
      if (value.schemaVersion === LEDGER_SCHEMA_VERSION && Array.isArray(value.entries)) {
        for (const candidate of value.entries) {
          const entry = readEntry(candidate);
          if (entry) {
            this.entries.set(ledgerKey(entry.scope, entry.requestId), entry);
          }
        }
      }
    } catch {
      // A missing or invalid ledger starts empty. Confirmation still fails closed if it cannot be written.
    }
  }

  private persist() {
    try {
      const unfinished = [...this.entries.values()].filter((entry) => entry.deliveryState !== "delivered");
      const delivered = [...this.entries.values()]
        .filter((entry) => entry.deliveryState === "delivered")
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, MAX_DELIVERED_ENTRIES);
      const keep = new Set([...unfinished, ...delivered].map((entry) => ledgerKey(entry.scope, entry.requestId)));
      for (const key of this.entries.keys()) {
        if (!keep.has(key)) {
          this.entries.delete(key);
        }
      }
      const payload: LedgerFile = {
        schemaVersion: LEDGER_SCHEMA_VERSION,
        legacyMessageIds: [...this.legacyMessageIds].slice(-MAX_DELIVERED_ENTRIES),
        entries: [...this.entries.values()]
      };
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.tmp`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporaryPath, this.filePath);
      return true;
    } catch {
      return false;
    }
  }
}
