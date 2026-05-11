import type {
  AssistantAttachment,
  AssistantChatMessage,
  AssistantRunEvent
} from "../../shared/contracts";

export function mergeAssistantAttachments(
  current: AssistantAttachment[] | undefined,
  next: AssistantAttachment[]
) {
  if (next.length === 0) {
    return current;
  }
  const merged = [...(current ?? [])];
  const knownIds = new Set(merged.map((attachment) => attachment.id));
  for (const attachment of next) {
    if (!knownIds.has(attachment.id)) {
      merged.push(attachment);
      knownIds.add(attachment.id);
    }
  }
  return merged;
}

function artifactRecordToAttachment(value: unknown): AssistantAttachment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.attachmentId === "string" ? record.attachmentId : "";
  const name = typeof record.name === "string" ? record.name : "";
  if (!id || !name) {
    return null;
  }
  return {
    id,
    name,
    mimeType: typeof record.mimeType === "string" ? record.mimeType : "application/octet-stream",
    sizeBytes: typeof record.sizeBytes === "number" && Number.isFinite(record.sizeBytes) ? record.sizeBytes : 0,
    text: "",
    kind: "artifact",
    ...(typeof record.artifactId === "string" ? { artifactId: record.artifactId } : {}),
    ...(typeof record.description === "string" ? { description: record.description } : {}),
    ...(typeof record.sha256 === "string" ? { sha256: record.sha256 } : {}),
    ...(typeof record.url === "string" ? { url: record.url } : {})
  };
}

export function getArtifactAttachmentsFromEvent(event: AssistantRunEvent) {
  if (event.type !== "artifact.publish") {
    return [];
  }
  const data = event.data && typeof event.data === "object" && !Array.isArray(event.data)
    ? event.data as Record<string, unknown>
    : {};
  const rawArtifacts = Array.isArray(event.artifacts)
    ? event.artifacts
    : Array.isArray(data.artifacts)
      ? data.artifacts
      : event.artifact
        ? [event.artifact]
        : data.artifact
          ? [data.artifact]
          : [];
  return rawArtifacts
    .map(artifactRecordToAttachment)
    .filter((attachment): attachment is AssistantAttachment => Boolean(attachment));
}

export function getArtifactAttachmentsFromMessages(messages: AssistantChatMessage[]) {
  const artifacts = new Map<string, AssistantAttachment>();
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      if (attachment.kind !== "artifact") {
        continue;
      }
      artifacts.set(attachment.artifactId || attachment.id, attachment);
    }
  }
  return Array.from(artifacts.values()).reverse();
}
