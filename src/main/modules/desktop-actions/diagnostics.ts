import type { DesktopActionErrorCategory, DesktopActionErrorDetails, DesktopActionRecovery } from "../../../shared/desktop-action-diagnostics";
import { randomUUID } from "node:crypto";

const categories: Record<string, DesktopActionErrorCategory> = {
  invalid_args: "validation", invalid_path: "validation", path_outside_workspace: "authorization",
  forbidden: "authorization", permission_denied: "authorization", confirmation_required: "authorization", user_cancelled: "authorization",
  unknown_action: "not_found", not_found: "not_found", file_unavailable: "not_found", project_missing: "not_found",
  workspace_unavailable: "unavailable", renderer_unavailable: "unavailable",
  renderer_timeout: "timeout", tooling_timeout: "timeout", tooling_busy: "conflict", output_exists: "conflict",
};

// Redact credential values, never diagnostic paths or metadata such as tokenCount.
export function isActionCredentialKey(key: string): boolean {
  return /^(?:(?:(?:access|refresh|session|id|auth|client|db|database|login|user|proxy)[_.-]?)?(?:token|password|passwd|pwd|secret)|authorization|cookies?|api[_. -]?key|credential|private[_.-]?key)$/iu.test(key);
}

export function sanitizeActionErrorText(value: string): string {
  return value
    .replace(/(["']?\b(?:(?:(?:access|refresh|session|id|auth|client|db|database|login|user|proxy)[_.-]?)?(?:token|password|passwd|pwd|secret)|authorization|cookies?|api[_. -]?key|credential|private[_.-]?key)["']?\s*[=:]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|Bearer\s+[^\s,;&"'}]+|[^\s,;&"'}]+)/giu, (_match, prefix: string, secret: string) => {
      const quote = secret.startsWith('"') ? '"' : secret.startsWith("'") ? "'" : "";
      return `${prefix}${quote}[REDACTED]${quote}`;
    })
    .replace(/(\bBearer\s+)[^\s,;&"'}]+/giu, "$1[REDACTED]")
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:)[^\s/@]*(@)/giu, "$1[REDACTED]$2");
}

function sanitizeDiagnostics(value: unknown, budget = { remaining: 12000 }, depth = 0): unknown {
  if (budget.remaining <= 0 || depth > 6) return "[TRUNCATED]";
  budget.remaining -= 8;
  if (typeof value === "string") {
    const text = sanitizeActionErrorText(value).slice(0, budget.remaining);
    budget.remaining -= text.length;
    return text;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitizeDiagnostics(item, budget, depth + 1));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    const priority = ["category", "stage", "executionState", "recovery", "cause", "issues", "diagnosticId"];
    const keys = [...new Set([...priority.filter(key => Object.hasOwn(value, key)), ...Object.keys(value)])].slice(0, 40);
    for (const key of keys) {
      if (budget.remaining <= 0) break;
      budget.remaining -= key.length;
      const item = (value as Record<string, unknown>)[key];
      result[key.slice(0, 128)] = isActionCredentialKey(key)
        ? "[REDACTED]" : sanitizeDiagnostics(item, budget, depth + 1);
    }
    return result;
  }
  return value;
}

export function normalizeActionDiagnostics(code: string, input: unknown): DesktopActionErrorDetails {
  const details = input && typeof input === "object" && !Array.isArray(input) ? sanitizeDiagnostics(input) as Record<string, unknown> : {};
  const validCategories = ["validation", "authorization", "not_found", "conflict", "unavailable", "timeout", "internal"];
  const category: DesktopActionErrorCategory = validCategories.includes(String(details.category)) ? details.category as DesktopActionErrorCategory
    : categories[code] || (details.stage && details.stage !== "internal" && ["manifest", "package", "archive", "arguments"].includes(String(details.stage)) ? "validation" : "internal");
  const recovery = details.recovery;
  const defaults: DesktopActionRecovery = category === "validation"
    ? { strategy: "fix_input", message: "Correct the reported arguments or resource validation issues before retrying." }
    : category === "authorization"
      ? { strategy: "user_action", message: "Resolve the reported authorization requirement through the Desktop UI before retrying." }
      : category === "not_found"
        ? { strategy: "fix_resource", message: "Verify the requested resource exists in the current Run workspace or action scope before retrying." }
        : { strategy: "inspect", message: "Inspect the failure and current resource state before retrying; do not automatically replay a mutation." };
  const result: DesktopActionErrorDetails = {
    ...details,
    category,
    stage: typeof details.stage === "string" ? details.stage : code === "invalid_args" ? "arguments" : category === "authorization" ? "authorization" : "execution",
    executionState: ["not_started", "partial", "rolled_back", "unknown"].includes(String(details.executionState)) ? details.executionState as DesktopActionErrorDetails["executionState"] : "unknown",
    recovery: recovery && typeof recovery === "object" && !Array.isArray(recovery) && "strategy" in recovery && "message" in recovery && typeof recovery.message === "string" && ["fix_input", "fix_resource", "restore_connection", "user_action", "repair_host", "retry_later", "inspect"].includes(String(recovery.strategy))
      ? recovery as DesktopActionRecovery
      : { ...defaults, message: typeof recovery === "string" ? recovery : typeof details.suggestion === "string" ? details.suggestion : defaults.message },
  };
  if (category === "internal" || category === "timeout") {
    result.diagnosticId = randomUUID();
    console.warn("[desktop-action-failure]", { code, ...result });
  }
  return result;
}
