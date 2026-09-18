import type { AgentWebclientRunOwner } from "../../../../shared/contracts";
import type { SiteControlScope } from "../../web-surfaces";

type Identity = { runId: string; chatId: string; owner: AgentWebclientRunOwner };
type Grant = Identity & { scope?: SiteControlScope };

function denied(message: string) {
  return Object.assign(new Error(message), { code: "site_control_unavailable" });
}

/** Separate from Root Observers and WorkPanel grants. Revoked identities never regain foreground access. */
export class RunSiteControlGrants {
  private readonly grants = new Map<string, Grant>();
  private readonly workPanelGrants = new Map<string, Identity & { scopes: Map<string, SiteControlScope>; ended: boolean }>();

  /** Called only after canonical WorkPanel Run readiness has been verified. */
  resolveWorkPanel(source: Record<string, unknown>, surfaceId: string, acquire: () => SiteControlScope): SiteControlScope {
    const runId = typeof source.runId === "string" ? source.runId.trim() : "";
    const chatId = typeof source.chatId === "string" ? source.chatId.trim() : "";
    const agentKey = typeof source.agentKey === "string" ? source.agentKey.trim() : "";
    if (!runId || !chatId || !agentKey || source.teamId || !surfaceId || this.grants.has(runId)) {
      throw denied("AWCP requires an exact webpage and a canonical Agent Chat Run.");
    }
    let grant = this.workPanelGrants.get(runId);
    if (grant && (grant.ended || grant.chatId !== chatId || grant.owner.kind !== "agent" || grant.owner.agentKey !== agentKey)) {
      throw denied("The AWCP source conflicts with its Run identity or the Run has ended.");
    }
    if (!grant) {
      grant = { runId, chatId, owner: { kind: "agent", agentKey }, scopes: new Map(), ended: false };
      this.workPanelGrants.set(runId, grant);
    }
    let scope = grant.scopes.get(surfaceId);
    if (!scope) {
      scope = acquire();
      grant.scopes.set(surfaceId, scope);
    }
    // Retain revoked scopes until Run cleanup: never silently rebind a replaced guest.
    scope.readContainer();
    return scope;
  }

  bind(identity: Identity, scope: SiteControlScope) {
    if (this.grants.has(identity.runId)) {
      scope.release("The Run already has an application binding.");
      throw denied("The Run application binding cannot be replaced.");
    }
    this.grants.set(identity.runId, { ...identity, scope });
    scope.activate();
  }

  resolve(source: Record<string, unknown>): SiteControlScope | undefined {
    const grant = typeof source.runId === "string" ? this.grants.get(source.runId.trim()) : undefined;
    if (!grant) return;
    const ownerMatches = grant.owner.kind === "agent"
      ? source.agentKey === grant.owner.agentKey && !source.teamId
      : source.teamId === grant.owner.teamId && !source.agentKey;
    if (source.chatId !== grant.chatId || !ownerMatches) throw denied("The CDP source conflicts with the accepted Run identity.");
    if (!grant.scope) throw denied("The Run application control grant has ended.");
    grant.scope.readContainer();
    return grant.scope;
  }

  revoke(runId: string) {
    const workPanel = this.workPanelGrants.get(runId);
    if (workPanel) {
      workPanel.ended = true;
      for (const scope of workPanel.scopes.values()) scope.release();
      workPanel.scopes.clear();
    }
    const grant = this.grants.get(runId);
    grant?.scope?.release();
    if (grant) grant.scope = undefined;
  }

  revokeAll() {
    for (const runId of new Set([...this.grants.keys(), ...this.workPanelGrants.keys()])) this.revoke(runId);
  }
}
