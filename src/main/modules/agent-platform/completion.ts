import { createHash } from "node:crypto";
import path from "node:path";
import type { AssistantStartRunRequest, AssistantTextCompletionResult } from "../../../shared/contracts";
import { AgentPlatformImageCompletionRequest, AgentPlatformImageCompletionResult, MAX_GENERATED_IMAGE_BYTES } from "./bridge-contracts";
import { readString } from "./bridge-values";
import {
  ImageGenerateOutcome,
  buildZenmiImageGenerateMessage,
  observeImageGenerateEvent,
  validGeneratedImageRelativePath
} from "./image-generation-events";
import type { PlatformClient } from "./platform-client";
import { readResponseBytesWithLimit } from "./platform-http-response";

/** Private completion operations behind the Assistant facade. */
export class ImageCompletion {
  constructor(
    private readonly platform: Pick<PlatformClient, "resolvePlatform" | "platformFetch">,
    private readonly completeText: (request: AssistantStartRunRequest, onRawEvent?: (event: Record<string, unknown>) => boolean | void, strictAttachments?: boolean) => Promise<AssistantTextCompletionResult>
  ) {}

  async completeImage(request: AgentPlatformImageCompletionRequest): Promise<AgentPlatformImageCompletionResult> {
    const outcome: ImageGenerateOutcome = {
      callCount: 0,
      resultSeen: false,
      ok: false,
      message: "",
      artifacts: []
    };
    const completion = await this.completeText({
      ...request,
      message: buildZenmiImageGenerateMessage(request)
    }, (event: Record<string, unknown>) => observeImageGenerateEvent(event, outcome), true);
    if (outcome.message && !outcome.ok) {
      return { ok: false, runId: completion.runId, chatId: completion.chatId, message: outcome.message, images: [] };
    }
    if (!outcome.resultSeen) {
      if (!completion.ok) {
        return { ok: false, runId: completion.runId, chatId: completion.chatId, message: completion.message, images: [] };
      }
      return {
        ok: false,
        runId: completion.runId,
        chatId: completion.chatId,
        message: "Zenmi 未返回 image_generate 工具结果。",
        images: []
      };
    }
    if (!outcome.ok) {
      return { ok: false, runId: completion.runId, chatId: completion.chatId, message: completion.message, images: [] };
    }
    const availability = await this.platform.resolvePlatform();
    if (!availability.ok) {
      return { ok: false, runId: completion.runId, chatId: completion.chatId, message: availability.message, images: [] };
    }
    const images: Extract<AgentPlatformImageCompletionResult, {
      ok: true;
    }>["images"] = [];
    for (const artifact of outcome.artifacts.slice(0, request.count)) {
      const relativePath = readString(artifact.relativePath).trim();
      if (!validGeneratedImageRelativePath(relativePath))
        continue;
      const resourceURL = new URL("/api/resource", availability.baseUrl);
      resourceURL.searchParams.set("file", `${completion.chatId}/${relativePath}`);
      const response = await this.platform.platformFetch(availability.baseUrl, resourceURL.toString(), {
        method: "GET",
        headers: { Authorization: `Bearer ${availability.token}` }
      });
      if (!response.ok)
        continue;
      const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      if (mimeType !== "image/png" && mimeType !== "image/jpeg" && mimeType !== "image/webp")
        continue;
      let bytes: Buffer;
      try {
        bytes = await readResponseBytesWithLimit(response, MAX_GENERATED_IMAGE_BYTES);
      }
      catch {
        continue;
      }
      if (bytes.length === 0)
        continue;
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const expectedSha256 = readString(artifact.sha256).trim().toLowerCase();
      if (expectedSha256 && expectedSha256 !== sha256)
        continue;
      images.push({
        name: path.basename(relativePath),
        mimeType,
        sizeBytes: bytes.length,
        sha256,
        dataBase64: bytes.toString("base64")
      });
    }
    if (images.length === 0) {
      return {
        ok: false,
        runId: completion.runId,
        chatId: completion.chatId,
        message: "Zenmi 已生成图片，但 Desktop 无法安全读取生成结果。",
        images: []
      };
    }
    return {
      ok: true,
      runId: completion.runId,
      chatId: completion.chatId,
      message: "Zenmi 图片生成成功。",
      images
    };
  }
}
