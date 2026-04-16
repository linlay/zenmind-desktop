import type { App } from "electron";
import type { AgentAuthIssueResult, AgentAuthRefreshReason } from "../shared/contracts";
import {
  createDesktopAccessToken,
  ensureKeyPairForPan,
  readPanPrivateKey
} from "./pan-auth";

export async function issueAgentAccessToken(
  app: App,
  _reason: AgentAuthRefreshReason
): Promise<AgentAuthIssueResult> {
  try {
    ensureKeyPairForPan(app);
    const token = createDesktopAccessToken(readPanPrivateKey(app));
    return {
      ok: true,
      token,
      message: "已签发 Desktop AGENT access token。"
    };
  } catch (reason) {
    return {
      ok: false,
      token: "",
      message: reason instanceof Error ? reason.message : String(reason)
    };
  }
}
