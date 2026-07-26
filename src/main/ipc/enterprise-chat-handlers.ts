import type {
  EnterpriseChatMarkReadInput,
  EnterpriseChatOpenDirectInput,
  EnterpriseChatSendMessageInput
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
    "enterpriseChat.sendMessage",
    async (_event: unknown, input: EnterpriseChatSendMessageInput) =>
      runtime.sendMessage(input)
  );
  ipcMain.handle(
    "enterpriseChat.markRead",
    async (_event: unknown, input: EnterpriseChatMarkReadInput) =>
      runtime.markRead(input)
  );
}
