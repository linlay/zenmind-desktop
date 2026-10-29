import { WEBAPP_ASSISTANT_MESSAGE_MAX_CHARS } from "./webapp-manifest";

export const WEBAPP_EXECUTE_TIMEOUT_MS = 600_000;
export const WEBAPP_EXECUTE_TRANSPORT_TIMEOUT_MS = 615_000;
export const WEBAPP_EXECUTE_RESPONSE_BYTES = 1024 * 1024;
export type WebappExecuteResult =
  | { chatId: string; status: "success"; output: Record<string, unknown> }
  | { chatId: string; status: "failure"; reason: string };
export type WebappExecuteInput = { message: string; outputSchema: Record<string, unknown>; input?: unknown };

export function isExecuteRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

export function validateWebappExecute(value: unknown): string | null {
  if (!isExecuteRecord(value) || Object.keys(value).some(key => !["message", "input", "outputSchema"].includes(key))) return "invalid_args";
  if (typeof value.message !== "string" || !value.message.trim()) return "invalid_args";
  if (value.message.length > WEBAPP_ASSISTANT_MESSAGE_MAX_CHARS) return "assistant_message_too_long";
  const schema = value.outputSchema;
  if (!isExecuteRecord(schema) || schema.type !== "object") return "invalid_args";
  // Bound recursion too: a small hostile JSON body can otherwise overflow Main's stack.
  function json(node: unknown, depth: number, input: boolean): boolean {
    if (depth > 64) return false;
    if (node === null || typeof node === "string" || typeof node === "boolean") return true;
    if (typeof node === "number") return Number.isFinite(node);
    if (Array.isArray(node)) return node.every(item => json(item, depth + 1, input));
    return isExecuteRecord(node) && !Object.getOwnPropertySymbols(node).length &&
      Object.entries(node).every(([key, item]) => (!input || key !== "$file") && json(item, depth + 1, input));
  }
  if (!json(schema, 0, false) || (value.input !== undefined && !json(value.input, 0, true))) return "invalid_args";
  return new TextEncoder().encode(JSON.stringify(schema)).length > 64 * 1024 ? "invalid_args" : null;
}
