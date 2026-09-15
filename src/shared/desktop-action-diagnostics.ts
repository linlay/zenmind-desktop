export type DesktopActionErrorCategory = "validation" | "authorization" | "not_found" | "conflict" | "unavailable" | "timeout" | "internal";
export type DesktopActionRecovery = {
  strategy: "fix_input" | "fix_resource" | "restore_connection" | "user_action" | "repair_host" | "retry_later" | "inspect";
  message: string;
};

export interface DesktopActionErrorDetails {
  category: DesktopActionErrorCategory;
  stage: string;
  executionState: "not_started" | "partial" | "rolled_back" | "unknown";
  recovery: DesktopActionRecovery;
  cause?: { code?: string; name?: string; message: string };
  issues?: unknown[];
  context?: Record<string, unknown>;
  diagnosticId?: string;
  [key: string]: unknown;
}

export function desktopActionErrorStatus(category: unknown): number {
  switch (category) {
    case "validation": return 400;
    case "authorization": return 403;
    case "not_found": return 404;
    case "conflict": return 409;
    case "unavailable": return 503;
    case "timeout": return 504;
    default: return 500;
  }
}
