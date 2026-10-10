import { readMainChatIdentity } from "../../shared/canonical-chat-sync";
import {
  AGENT_WEBCLIENT_AWAITING_DIGIT_MESSAGE_TYPE,
  SERVICE_WEBVIEW_BRIDGE_DELIVER_CHANNEL,
  type AgentWebclientAwaitingDigitMessage,
} from "../../shared/service-webview-bridge";
import type { MainChatCommitSnapshot } from "../service-webview/ServiceWebviewSurface";

/** No focus handoff or queued retry: a digit belongs only to the displayed Chat. */
export function forwardMainChatAwaitingDigit(input: {
  chatId: string;
  agentKey: string;
  digit: string;
  currentRoute: string;
  registeredRoute: string;
  committed: MainChatCommitSnapshot | null;
  webview: Pick<Electron.WebviewTag, "getWebContentsId" | "send"> | null;
}): boolean {
  const { committed, webview, chatId, agentKey, digit } = input;
  const desired = readMainChatIdentity(input.currentRoute);
  if (
    !/^[1-9]$/.test(digit) || !webview ||
    input.registeredRoute !== input.currentRoute ||
    desired?.kind !== "canonical" ||
    desired.chatId !== chatId || desired.agentKey !== agentKey ||
    committed?.identity.kind !== "canonical" ||
    committed.identity.chatId !== chatId || committed.identity.agentKey !== agentKey
  ) return false;
  try {
    if (webview.getWebContentsId() !== committed.webContentsId) return false;
    // Plain digits use the same Chromium path on macOS and Windows, including numpad keys.
    const message: AgentWebclientAwaitingDigitMessage = {
      type: AGENT_WEBCLIENT_AWAITING_DIGIT_MESSAGE_TYPE, chatId, agentKey, digit,
    };
    void webview.send(SERVICE_WEBVIEW_BRIDGE_DELIVER_CHANNEL, message).catch(() => {
      // Navigation can dispose the guest after the identity check; never replay the key.
    });
    return true;
  } catch {
    // A guest that is loading or being replaced cannot consume this key.
    return false;
  }
}
