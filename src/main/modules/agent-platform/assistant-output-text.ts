import { readString } from "./bridge-values";
import { type AssistantEvent } from "../../../shared/contracts";
import fs from "node:fs";

export function readErrorPayloadText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  const record = value as Record<string, unknown>;
  const direct = readString(record.message)
    || readString(record.msg)
    || readString(record.detail)
    || readString(record.code)
    || readString(record.type);
  if (direct) {
    return direct;
  }
  try {
    return JSON.stringify(record);
  } catch {
    return "";
  }
}

export const PLATFORM_OUTPUT_TEXT_KEYS = [
  "result",
  "answer",
  "finalMessage",
  "assistantText",
  "lastRunContent",
  "output",
  "stdout",
  "content",
  "text",
  "summary"
] as const;

export function readOutputTextFromRecord(record: Record<string, unknown>, keys: readonly string[] = PLATFORM_OUTPUT_TEXT_KEYS): string {
  for (const key of keys) {
    const value = readString(record[key]);
    if (value) {
      return value;
    }
  }
  const data = record.data;
  if (typeof data === "string") {
    return data.trim();
  }
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const nested = readOutputTextFromRecord(data as Record<string, unknown>, keys);
    if (nested) {
      return nested;
    }
  }
  return "";
}

export function readAssistantEventOutputText(event: AssistantEvent): string {
  if (event.message?.trim()) {
    return event.message.trim();
  }
  if (event.delta?.trim()) {
    return event.delta.trim();
  }
  const data = event.data;
  if (typeof data === "string") {
    return data.trim();
  }
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return readOutputTextFromRecord(data as Record<string, unknown>);
  }
  return "";
}

export function readAssistantTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (part && typeof part === "object") {
        return readString((part as Record<string, unknown>).text);
      }
      return "";
    })
    .join("")
    .trim();
}

export function readFinalAssistantTextFromMessages(messages: unknown): string {
  if (!Array.isArray(messages)) {
    return "";
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") {
      continue;
    }
    const record = message as Record<string, unknown>;
    if (record.role !== "assistant") {
      continue;
    }
    const text = readAssistantTextContent(record.content);
    if (text) {
      return text;
    }
  }
  return "";
}

export function readFinalAssistantTextFromChatFile(filePath: string, runId: string): string {
  if (!filePath || !fs.existsSync(filePath)) {
    return "";
  }
  let lines: string[];
  try {
    lines = fs.readFileSync(filePath, "utf8").trim().split(/\n+/u).filter(Boolean);
  } catch {
    return "";
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(lines[index]) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (runId && readString(record.runId) && readString(record.runId) !== runId) {
      continue;
    }
    const text = readFinalAssistantTextFromMessages(record.messages);
    if (text) {
      return text;
    }
  }
  return "";
}
