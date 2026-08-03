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
  EnterpriseChatSendScreenshotInput,
  EnterpriseChatSendSupportBundleInput
} from "../../shared/contracts";
import type { EnterpriseChatRuntime } from "../enterprise-chat-runtime";

export function registerEnterpriseChatIpcHandlers(
  ipcMain: any,
  runtime: EnterpriseChatRuntime
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
