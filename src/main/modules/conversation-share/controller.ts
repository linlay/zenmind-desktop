import type { AssistantConversationShareRequest, AssistantConversationShareCreateResult } from "../../../shared/contracts";
import type { ShareFacade } from "../shares";
import type { ConversationHtmlRenderService } from "./html-render-service";
import { t } from "../../support/i18n/main-i18n";

export async function createConversationShare(
  preparer: Pick<ConversationHtmlRenderService, "prepareChatShare">,
  shares: Pick<ShareFacade, "publish">,
  request: AssistantConversationShareRequest,
): Promise<AssistantConversationShareCreateResult> {
  const chatId = typeof request?.chatId === "string" ? request.chatId.trim() : "";
  if (!chatId) return { ok: false, message: t("assistant.chatIdRequired") };
  if (Buffer.byteLength(chatId, "utf8") > 255 || /\p{Cc}/u.test(chatId)) return { ok: false, message: t("assistant.chatShareConversationIdInvalid") };
  return shares.publish(async (limits) => {
    const prepared = await preparer.prepareChatShare(chatId, limits);
    if (!prepared.ok) return prepared;
    return { manifest: prepared.bytes, resources: prepared.attachments,
      ...(prepared.attachmentsOmitted ? { warning: t(prepared.attachmentUnauthorized
        ? "assistant.chatShareSourceUnauthorized" : "assistant.chatShareAttachmentsOmitted") } : {}) };
  });
}
