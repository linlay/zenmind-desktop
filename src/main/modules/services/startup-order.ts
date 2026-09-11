import type { ServiceId } from "../../../shared/contracts";

export const STARTUP_RESTORE_SERVICE_ORDER = [
  "identity-center",
  "agent-platform",
  "agent-webclient"
] as const satisfies readonly ServiceId[];
