import type {
  AgentRealtimeDebugTraceEntry,
  AgentRealtimeRecordingEventFilter,
  AgentRealtimeRecordingSample,
} from "../../../../shared/contracts";

export type RuntimeRecordingWorkerRequest =
  | { requestId: number; action: "start"; recordingId: string; name: string; startedAt: number }
  | { requestId: number; action: "append-events"; recordingId: string; events: AgentRealtimeDebugTraceEntry[] }
  | { requestId: number; action: "append-sample"; recordingId: string; sample: AgentRealtimeRecordingSample }
  | { requestId: number; action: "stop"; recordingId: string; endedAt: number; incompleteReason?: string }
  | { requestId: number; action: "list" }
  | { requestId: number; action: "query-events"; recordingId: string; filter: AgentRealtimeRecordingEventFilter }
  | { requestId: number; action: "get-event"; recordingId: string; sequence: number }
  | { requestId: number; action: "get-samples"; recordingId: string; from?: number; to?: number }
  | { requestId: number; action: "delete"; recordingId: string }
  | { requestId: number; action: "export-source"; recordingId: string };

export type RuntimeRecordingWorkerResponse = {
  requestId: number;
  ok: boolean;
  value?: unknown;
  error?: string;
};
