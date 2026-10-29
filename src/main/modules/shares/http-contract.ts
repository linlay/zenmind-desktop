import type { ShareRecord } from "../../../shared/contracts/shares";

/** HTTP-only DTO. Decode UTC RFC3339 milliseconds before projecting across IPC. */
export interface ShareRecordWire extends Omit<ShareRecord, "createdAt" | "lastAccessedAt"> {
  createdAt: string;
  lastAccessedAt: string | null;
}

export interface ShareListWire {
  items: ShareRecordWire[];
}
