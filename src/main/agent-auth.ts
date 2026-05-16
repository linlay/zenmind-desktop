import type { App } from "electron";
import type { AgentAuthIssueResult, AgentAuthRefreshReason } from "../shared/contracts";
import { issueAppServerAccessToken } from "./app-server-auth";

export async function issueAgentAccessToken(
  app: App,
  _reason: AgentAuthRefreshReason
): Promise<AgentAuthIssueResult> {
  try {
    const token = await issueAppServerAccessToken(app);
    return {
      ok: true,
      token,
      message: "已由 zenmind-app-server 签发 Desktop AGENT access token。"
    };
  } catch (reason) {
    return {
      ok: false,
      token: "",
      message: reason instanceof Error ? reason.message : String(reason)
    };
  }
}
