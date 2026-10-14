import type { WebContents } from "electron";
import { normalizeWebsiteCredentialOrigin } from "../../../../shared/website-credentials";
import type { WebsiteCredentialStore } from "../store";
import { fillLoginForm, type LoginFillResult, type LoginFillTarget } from "./executor";

export type AgentCredentialAccount = { accountId: string; username: string; isDefault: boolean };

/**
 * What an agent may do with saved passwords: see the masked accounts of the page it is
 * authorized on, and ask Desktop to fill one. Passwords never leave this module.
 */
export function createAgentCredentialAccess(store: Pick<WebsiteCredentialStore, "listForOrigin" | "resolveForOrigin" | "markUsed">) {
  /** The origin Main sees for the page's top frame; never taken from the caller. */
  const pageOrigin = (contents: Pick<WebContents, "getURL" | "isDestroyed">) =>
    contents.isDestroyed() ? null : normalizeWebsiteCredentialOrigin(contents.getURL());

  return {
    pageOrigin,

    /** Accounts the user allows agents to use on `origin`, the fill default first. */
    list(origin: string): AgentCredentialAccount[] {
      return store.listForOrigin(origin, { agentOnly: true }).map((item, index) => ({
        accountId: item.id,
        username: item.maskedUsername,
        isDefault: index === 0
      }));
    },

    async fill(
      target: LoginFillTarget & { contents: Pick<WebContents, "getURL" | "isDestroyed" | "executeJavaScriptInIsolatedWorld"> },
      request: {
        origin: string;
        accountId: string;
        submit: boolean;
        /** Re-checks page authorization and cancellation; runs after any queueing, right before the write. */
        authorize?: () => Promise<void>;
        sleep?: (ms: number) => Promise<void>;
      }
    ): Promise<LoginFillResult> {
      let usedId = "";
      const result = await fillLoginForm(target, {
        submit: request.submit,
        isPageCurrent: () => pageOrigin(target.contents) === request.origin,
        // The account is read only now, so turning off agent use while the request waited still stops it.
        async prepare() {
          await request.authorize?.();
          const secret = store.resolveForOrigin(request.origin, { agentOnly: true, id: request.accountId });
          if (!secret) return null;
          usedId = secret.id;
          return { username: secret.username, password: secret.password };
        },
        ...(request.sleep ? { sleep: request.sleep } : {})
      });
      if (usedId && (result.status === "filled" || result.status === "submitted")) {
        try { store.markUsed(usedId); } catch { /* Bookkeeping only; the fill already happened. */ }
      }
      return result;
    }
  };
}

export type AgentCredentialAccess = ReturnType<typeof createAgentCredentialAccess>;
