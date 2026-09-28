import fs from "node:fs";
import type { AssistantAttachment } from "../../../shared/contracts";
import { PlatformUploadTicket } from "./bridge-contracts";
import type { PlatformClient } from "./platform-client";
import { dataUrlToBlob, readErrorText, unwrapApiResponse } from "./platform-http-response";

/** Private attachment upload operations behind the Assistant facade. */
export class AttachmentUploader {
  constructor(
    private readonly platform: Pick<PlatformClient, "platformFetch">,
    private readonly resolveAttachmentPath: (chatId: string, attachmentId: string) => string
  ) {}

  async uploadAttachments(baseUrl: string, token: string, chatId: string, runId: string, attachments: AssistantAttachment[], strict = false) {
    const references: PlatformUploadTicket[] = [];
    for (const attachment of attachments) {
      const ticket = strict
        ? await this.uploadAttachment(baseUrl, token, chatId, runId, attachment)
        : await this.uploadAttachment(baseUrl, token, chatId, runId, attachment).catch(() => null);
      if (ticket) {
        references.push(ticket);
      }
    }
    return references;
  }

  private async uploadAttachment(baseUrl: string, token: string, chatId: string, runId: string, attachment: AssistantAttachment) {
    const formData = new FormData();
    formData.set("requestId", runId);
    formData.set("chatId", chatId);
    formData.set("name", attachment.name);
    const fileBlob = await this.attachmentToBlob(chatId, attachment);
    formData.set("file", fileBlob, attachment.name);
    const response = await this.platform.platformFetch(baseUrl, "/api/upload", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`
      },
      body: formData
    });
    if (!response.ok) {
      throw new Error(await readErrorText(response));
    }
    const payload = unwrapApiResponse<{
      upload: PlatformUploadTicket;
    }>(await response.json());
    return payload.upload;
  }

  private async attachmentToBlob(chatId: string, attachment: AssistantAttachment) {
    if (attachment.dataUrl) {
      const blob = dataUrlToBlob(attachment.dataUrl, attachment.mimeType);
      if (blob) {
        return blob;
      }
    }
    try {
      const attachmentPath = this.resolveAttachmentPath(chatId, attachment.id);
      const buffer = await fs.promises.readFile(attachmentPath);
      return new Blob([buffer], { type: attachment.mimeType || "application/octet-stream" });
    }
    catch {
      const fallback = attachment.text || attachment.name || attachment.id;
      return new Blob([Buffer.from(fallback, "utf8")], { type: attachment.mimeType || "text/plain" });
    }
  }
}
