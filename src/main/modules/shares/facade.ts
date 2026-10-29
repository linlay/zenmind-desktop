import type { App } from "electron";
import type { ShareCreateResult, ShareLimits, ShareListResult, ShareRevokeResult } from "../../../shared/contracts/shares";
import { getDesktopSsoStatus, isDesktopSsoCredentialRuntimeReady, subscribeDesktopSsoCredentialRevocation } from "../identity";
import { t } from "../../support/i18n/main-i18n";
import { ShareHttpClient, type PreparedShare } from "./http-client";
import { ShareHttpError, type ShareTarget } from "./http-transport";
import { resolveShareOrigin } from "./target";
import { createShareReceiverRouter } from "./receiver";

export function createShareFacade(options: { app: App; refreshToken: (force?: boolean) => Promise<string>; fetchImpl?: typeof fetch }) {
  const client = new ShareHttpClient(options.fetchImpl);
  const resolve = (id: string, signal?: AbortSignal) => {
    const origin = resolveShareOrigin(options.app);
    if (!origin.ok) return Promise.reject(new Error(origin.message));
    return client.resolve(origin.origin, id, signal);
  };
  const receivers = createShareReceiverRouter({ resolve });
  async function authenticated<T>(run: (call: <R>(request: (target: ShareTarget) => Promise<R>) => Promise<R>) => Promise<T>): Promise<T> {
    const origin = resolveShareOrigin(options.app, true);
    if (!origin.ok) throw new Error(origin.message);
    const initial = getDesktopSsoStatus(options.app);
    const controller = new AbortController();
    const unsubscribe = subscribeDesktopSsoCredentialRevocation(() => controller.abort());
    try {
      let token = await options.refreshToken();
      const status = getDesktopSsoStatus(options.app);
      const identity = JSON.stringify([status.user?.issuer, status.user?.sub]);
      if (!status.authenticated || !isDesktopSsoCredentialRuntimeReady() || !status.user?.sub || !token ||
          (initial.authenticated && identity !== JSON.stringify([initial.user?.issuer, initial.user?.sub]))) {
        throw new Error(t("assistant.chatShareLoginRequired"));
      }
      const validate = () => {
        const current = getDesktopSsoStatus(options.app);
        if (controller.signal.aborted || !isDesktopSsoCredentialRuntimeReady() ||
            identity !== JSON.stringify([current.user?.issuer, current.user?.sub])) throw new Error(t("assistant.chatShareUnauthorized"));
      };
      const result = await run(async (request) => {
        validate();
        let response;
        try { response = await request({ origin: origin.origin, accessToken: token, signal: controller.signal }); }
        catch (error) {
          validate();
          if (!(error instanceof ShareHttpError) || error.status !== 401) throw error;
          token = await options.refreshToken(true);
          validate();
          if (!token) throw new Error(t("assistant.chatShareUnauthorized"));
          response = await request({ origin: origin.origin, accessToken: token, signal: controller.signal });
        }
        validate();
        return response;
      });
      validate();
      return result;
    } finally { unsubscribe(); }
  }
  return {
    registerReceiver: receivers.register,
    receive: receivers.receive,
    dispose: receivers.dispose,
    async publish(prepare: (limits: ShareLimits) => Promise<PreparedShare | { ok: false; message: string }>): Promise<ShareCreateResult> {
      try {
        return await authenticated(async (call) => {
          const prepared = await prepare(await call((target) => client.limits(target)));
          if ("ok" in prepared) return prepared;
          const record = await call((target) => client.create(target, prepared));
          return { ok: true, message: t("assistant.chatShareCreated"), record, ...(prepared.warning ? { warning: prepared.warning } : {}) };
        });
      } catch (error) { return failure(error); }
    },
    async list(): Promise<ShareListResult> {
      try { return { ok: true, message: "", records: await authenticated((call) => call((target) => client.list(target))) }; }
      catch (error) { return failure(error); }
    },
    async revoke(id: string): Promise<ShareRevokeResult> {
      if (typeof id !== "string" || id.trim() !== id || !/^[A-Za-z0-9_-]{1,80}$/u.test(id)) return { ok: false, message: t("assistant.chatShareInvalidId") };
      try {
        await authenticated((call) => call((target) => client.revoke(target, id)));
        return { ok: true, message: t("assistant.chatShareRevoked"), shareId: id };
      } catch (error) { return failure(error); }
    },
    resolve,
  };
}
export type ShareFacade = ReturnType<typeof createShareFacade>;

function failure(error: unknown): { ok: false; message: string } {
  if (!(error instanceof ShareHttpError)) return { ok: false, message: error instanceof Error ? error.message : t("assistant.chatShareRequestFailed") };
  const key = error.code === "share_api_upgrade_required" ? "share.serverUpgradeRequired"
    : error.status === 401 || error.status === 403 ? "assistant.chatShareUnauthorized"
    : error.status === 413 ? error.code === "snapshot_too_large" ? "assistant.chatShareSnapshotTooLarge" : error.code === "resources_too_large" ? "assistant.chatShareResourcesTooLarge" : "assistant.chatShareUploadRejected"
    : error.status === 404 ? "assistant.chatShareMissing"
    : error.kind === "invalid_response" ? "assistant.chatShareInvalidResponse"
    : error.kind === "timeout" || error.kind === "unavailable" || (error.status ?? 0) >= 500 ? "assistant.chatShareTunnelUnavailable"
    : "assistant.chatShareRequestFailed";
  return { ok: false, message: t(key) };
}
