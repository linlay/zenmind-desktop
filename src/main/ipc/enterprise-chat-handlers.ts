import type {
  EnterpriseChatAttachmentInput,
  EnterpriseChatCreateGroupInput,
  EnterpriseChatExecuteActionInput,
  EnterpriseChatMarkReadInput,
  EnterpriseChatOpenConversationInput,
  EnterpriseChatOpenDirectInput,
  EnterpriseChatSaveSelfProfileInput,
  EnterpriseChatSendFilesInput,
  EnterpriseChatSendMessageInput,
  EnterpriseChatSendPastedFilesInput,
  EnterpriseChatSendRawAgentChatInput,
  EnterpriseChatSendScreenshotInput,
  EnterpriseChatSendSupportBundleInput
} from "../../shared/contracts";
import type { EnterpriseChatRuntime } from "../enterprise-chat-runtime";

type RawAgentChatBridge = {
  downloadRawChatJSONL(chatId: string): Promise<
    | { ok: true; filename: string; bytes: Buffer }
    | { ok: false; message: string }
  >;
};

export function registerEnterpriseChatIpcHandlers(
  ipcMain: any,
  runtime: EnterpriseChatRuntime,
  assistantBridge: RawAgentChatBridge
) {
  ipcMain.handle("enterpriseChat.getState", async () => runtime.getState());
  ipcMain.handle("enterpriseChat.refresh", async () => runtime.refresh());
  ipcMain.handle(
    "enterpriseChat.openDirectConversation",
    async (_event: unknown, input: EnterpriseChatOpenDirectInput) =>
      runtime.openDirectConversation(input)
  );
  ipcMain.handle(
    "enterpriseChat.openConversation",
    async (_event: unknown, input: EnterpriseChatOpenConversationInput) =>
      runtime.openConversation(input)
  );
  ipcMain.handle(
    "enterpriseChat.createGroup",
    async (_event: unknown, input: EnterpriseChatCreateGroupInput) =>
      runtime.createGroup(input)
  );
  ipcMain.handle(
    "enterpriseChat.sendMessage",
    async (_event: unknown, input: EnterpriseChatSendMessageInput) =>
      runtime.sendMessage(input)
  );
  ipcMain.handle(
    "enterpriseChat.sendFiles",
    async (_event: unknown, input: EnterpriseChatSendFilesInput) =>
      runtime.sendFiles(input)
  );
  ipcMain.handle(
    "enterpriseChat.sendSupportBundle",
    async (_event: unknown, input: EnterpriseChatSendSupportBundleInput) =>
      runtime.sendSupportBundle(input)
  );
  ipcMain.handle(
    "enterpriseChat.sendRawAgentChat",
    async (_event: unknown, input: EnterpriseChatSendRawAgentChatInput) => {
      const conversationId = input?.conversationId?.trim() ?? "";
      const chatId = input?.chatId?.trim() ?? "";
      const clientMessageId = input?.clientMessageId?.trim() ?? "";
      if (!conversationId || !chatId || !clientMessageId) {
        throw new Error("conversationId, chatId, and clientMessageId are required.");
      }
      const rawChat = await assistantBridge.downloadRawChatJSONL(chatId);
      if (!rawChat.ok) {
        throw new Error(rawChat.message);
      }
      return runtime.sendRawAgentChat(input, rawChat);
    }
  );
  ipcMain.handle(
    "enterpriseChat.sendPastedFiles",
    async (_event: unknown, input: EnterpriseChatSendPastedFilesInput) =>
      runtime.sendPastedFiles(input)
  );
  ipcMain.handle(
    "enterpriseChat.sendScreenshot",
    async (_event: unknown, input: EnterpriseChatSendScreenshotInput) =>
      runtime.sendScreenshot(input)
  );
  ipcMain.handle(
    "enterpriseChat.loadAttachment",
    async (_event: unknown, input: EnterpriseChatAttachmentInput) =>
      runtime.loadAttachment(input)
  );
  ipcMain.handle(
    "enterpriseChat.downloadAttachment",
    async (_event: unknown, input: EnterpriseChatAttachmentInput) =>
      runtime.downloadAttachment(input)
  );
  ipcMain.handle(
    "enterpriseChat.executeDesktopAction",
    async (_event: unknown, input: EnterpriseChatExecuteActionInput) =>
      runtime.executeMessageDesktopAction(input)
  );
  ipcMain.handle(
    "enterpriseChat.markRead",
    async (_event: unknown, input: EnterpriseChatMarkReadInput) =>
      runtime.markRead(input)
  );
  ipcMain.handle(
    "enterpriseChat.saveSelfProfile",
    async (_event: unknown, input: EnterpriseChatSaveSelfProfileInput) =>
      runtime.saveSelfProfile(input)
  );
  ipcMain.handle("enterpriseChat.selectSelfAvatar", async () => runtime.selectSelfAvatar());
  ipcMain.handle("enterpriseChat.clearSelfAvatar", async () => runtime.clearSelfAvatar());
}
