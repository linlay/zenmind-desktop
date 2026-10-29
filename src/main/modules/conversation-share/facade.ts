import type { App } from "electron";
import type {
  AssistantConversationShareRequest
} from "../../../shared/contracts";
import { createConversationShare } from "./controller";
import type { ShareFacade } from "../shares";
import { saveConversationHtmlExport } from "./html-export";
import {
  ConversationHtmlRenderService,
  type ConversationSnapshotRequestProvider
} from "./html-render-service";

export type ConversationShareFacadeOptions = {
  app: App;
  snapshotProvider: ConversationSnapshotRequestProvider;
  workerPath?: string;
  shares: ShareFacade;
};

export function createConversationShareFacade(options: ConversationShareFacadeOptions) {
  const renderer = new ConversationHtmlRenderService({
    snapshotProvider: options.snapshotProvider,
    workerPath: options.workerPath
  });

  return {
    start: () => renderer.start(),
    dispose: () => renderer.dispose(),
    exportChatHtml: (chatId: string, platform: NodeJS.Platform | string = process.platform) =>
      saveConversationHtmlExport(options.app, renderer, chatId, platform),
    create: (request: AssistantConversationShareRequest) =>
      createConversationShare(renderer, options.shares, request),
    list: () => options.shares.list(),
    revoke: (shareId: string) => options.shares.revoke(shareId)
  };
}

export type ConversationShareFacade = ReturnType<typeof createConversationShareFacade>;
