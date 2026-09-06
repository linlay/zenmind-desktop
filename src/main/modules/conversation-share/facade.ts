import type { App } from "electron";
import type {
  AssistantConversationShareRequest,
  ServiceState
} from "../../../shared/contracts";
import {
  createConversationShare,
  listConversationShares,
  revokeConversationShare
} from "./controller";
import { saveConversationHtmlExport } from "./html-export";
import {
  ConversationHtmlRenderService,
  type ConversationSnapshotRequestProvider
} from "./html-render-service";
import { TunnelConversationShareClient } from "./tunnel-client";

export type ConversationShareFacadeOptions = {
  app: App;
  snapshotProvider: ConversationSnapshotRequestProvider;
  getServiceState?: (app: App, serviceId: string) => Promise<ServiceState>;
  workerPath?: string;
  fetchImpl?: typeof globalThis.fetch;
};

export function createConversationShareFacade(options: ConversationShareFacadeOptions) {
  const renderer = new ConversationHtmlRenderService({
    app: options.app,
    snapshotProvider: options.snapshotProvider,
    getServiceState: options.getServiceState,
    workerPath: options.workerPath
  });
  const client = new TunnelConversationShareClient(options.fetchImpl);

  return {
    start: () => renderer.start(),
    dispose: () => renderer.dispose(),
    exportChatHtml: (chatId: string, platform: NodeJS.Platform | string = process.platform) =>
      saveConversationHtmlExport(options.app, renderer, chatId, platform),
    create: (request: AssistantConversationShareRequest) =>
      createConversationShare(options.app, renderer, client, request),
    list: (chatId: string) => listConversationShares(options.app, client, chatId),
    revoke: (shareId: string) => revokeConversationShare(options.app, client, shareId)
  };
}

export type ConversationShareFacade = ReturnType<typeof createConversationShareFacade>;
