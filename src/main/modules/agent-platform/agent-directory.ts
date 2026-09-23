import type { AssistantNavAgentItem, AssistantNavAgentItemsResult, DesktopPetAgentOption } from "../../../shared/contracts";
import { t } from "../../support/i18n/main-i18n";
import { PlatformAdminRegistryListResponse, PlatformAgentSummary } from "./bridge-contracts";
import { nowEpochMillis } from "./bridge-values";
import type { PlatformClient } from "./platform-client";

/** Private agent directory operations behind the Assistant facade. */
export class AgentDirectory {
  constructor(
    private readonly platform: Pick<PlatformClient, "getJson" | "resolvePlatform">,
    private readonly ports: { toDesktopPetAgentOptions: (agents: unknown) => DesktopPetAgentOption[]; readNavigationAgents: (baseUrl: string, token: string) => Promise<AssistantNavAgentItem[]>; readCopilotAgents: (baseUrl: string, token: string) => Promise<AssistantNavAgentItem[]> }
  ) {}

  async listAgents(): Promise<DesktopPetAgentOption[]> {
    const data = await this.platform.getJson<PlatformAgentSummary[]>("/api/agents", {
      fallbackWhenUnavailable: []
    });
    return this.ports.toDesktopPetAgentOptions(Array.isArray(data) ? data : []);
  }

  async listMcpRuntimeStatuses() {
    const data = await this.platform.getJson<PlatformAdminRegistryListResponse>("/api/admin/registries");
    return (data.items ?? [])
      .filter((item) => item.category === "mcp-servers" && (item.key?.trim() || item.file?.trim()))
      .map((item) => ({
        serverKey: item.key?.trim() || item.file?.trim().replace(/\.ya?ml$/iu, "") || "",
        status: item.status?.trim() ?? "",
        syncStatus: item.summary?.syncStatus?.trim() ?? "",
        toolCount: Number.isFinite(item.summary?.toolCount)
          ? Math.max(0, Math.trunc(item.summary?.toolCount ?? 0))
          : 0,
        message: item.summary?.syncDiagnostic?.message?.trim() || item.diagnostic?.message?.trim() || ""
      }));
  }

  async listNavigationAgents(): Promise<AssistantNavAgentItemsResult> {
    const availability = await this.platform.resolvePlatform();
    if (!availability.ok) {
      return {
        ok: false,
        items: [],
        chatItems: [],
        chatItemsHasMore: false,
        message: availability.message,
        updatedAt: nowEpochMillis()
      };
    }
    return {
      ok: true,
      items: await this.ports.readNavigationAgents(availability.baseUrl, availability.token),
      chatItems: [],
      chatItemsHasMore: false,
      message: t("assistant.navigationStatusRead"),
      updatedAt: nowEpochMillis()
    };
  }

  async listCopilotAgents(): Promise<AssistantNavAgentItemsResult> {
    const availability = await this.platform.resolvePlatform();
    if (!availability.ok) {
      return {
        ok: false,
        items: [],
        chatItems: [],
        chatItemsHasMore: false,
        message: availability.message,
        updatedAt: nowEpochMillis()
      };
    }
    return {
      ok: true,
      items: await this.ports.readCopilotAgents(availability.baseUrl, availability.token),
      chatItems: [],
      chatItemsHasMore: false,
      message: t("assistant.copilotAgentsRead"),
      updatedAt: nowEpochMillis()
    };
  }
}
