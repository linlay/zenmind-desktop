import type { AgentWebclientRunOwner } from "../../../../shared/contracts";
import type { SiteCdpScope } from "../../web-surfaces";

type Identity = { runId: string; chatId: string; owner: AgentWebclientRunOwner };
type Grant = Identity & { scope?: SiteCdpScope };

function denied(message: string) {
  return Object.assign(new Error(message), { code: "site_control_unavailable" });
}

/** Separate from Root Observers and WorkPanel grants. Revoked identities never regain foreground access. */
export class RunSiteCdpGrants {
  private readonly grants = new Map<string, Grant>();

  bind(identity: Identity, scope: SiteCdpScope) {
    if (this.grants.has(identity.runId)) {
      scope.release("The Run already has an application binding.");
      throw denied("The Run application binding cannot be replaced.");
    }
    this.grants.set(identity.runId, { ...identity, scope });
    scope.activate();
  }

  resolve(source: Record<string, unknown>): SiteCdpScope | undefined {
    const grant = typeof source.runId === "string" ? this.grants.get(source.runId.trim()) : undefined;
    if (!grant) return;
    const ownerMatches = grant.owner.kind === "agent"
      ? source.agentKey === grant.owner.agentKey && !source.teamId
      : source.teamId === grant.owner.teamId && !source.agentKey;
    if (source.chatId !== grant.chatId || !ownerMatches) throw denied("The CDP source conflicts with the accepted Run identity.");
    if (!grant.scope) throw denied("The Run application control grant has ended.");
    grant.scope.readSurface();
    return grant.scope;
  }

  revoke(runId: string) {
    const grant = this.grants.get(runId);
    grant?.scope?.release();
    if (grant) grant.scope = undefined;
  }

  revokeAll() {
    for (const runId of this.grants.keys()) this.revoke(runId);
  }
}
