import { useCallback, useEffect, useRef, useState } from "react";
import type { WebappEntry, WebappPublishInfo, WebappPublishState, WebappPublishStatusResult, WebappRuntimeState } from "../../../shared/contracts";
import type { TranslationKey } from "../../../shared/i18n";

export function getWebappPublishPresentation(
  state: WebappPublishState | null | undefined,
  info: WebappPublishInfo | null | undefined,
  runtime: WebappRuntimeState | null | undefined
): { label: TranslationKey; className: string } {
  if (state === undefined) return { label: "settings.webapps.publishStatusChecking", className: "loading" };
  if (!state?.active) return { label: "settings.webapps.publishStatusNotPublished", className: "idle" };
  if (runtime === undefined) return { label: "settings.webapps.publishStatusChecking", className: "loading" };
  if (runtime?.status !== "running") return { label: "settings.webapps.publishAppStopped", className: "warning" };
  if (!info) return { label: "settings.webapps.publishStatusChecking", className: "loading" };
  return info.tunnelConnected
    ? { label: "settings.webapps.publishStatusTunnelConnected", className: "running" }
    : { label: "settings.webapps.publishTunnelOffline", className: "warning" };
}

export function useWebappPublishStatus(
  active: boolean,
  items: readonly Pick<WebappEntry, "id">[],
  onStateChange: ((id: string, state: WebappPublishState | null) => void) | undefined,
  onError: (message: string) => void
) {
  const [infoById, setInfoById] = useState<Record<string, WebappPublishInfo | null>>({});
  const callbacks = useRef({ onStateChange, onError });
  callbacks.current = { onStateChange, onError };
  const enabled = useRef(false);
  const requests = useRef<Record<string, number>>({});

  const accept = useCallback((id: string, result: Pick<WebappPublishStatusResult, "info" | "state">) => {
    requests.current[id] = (requests.current[id] ?? 0) + 1;
    if (!enabled.current) return;
    setInfoById((current) => ({ ...current, [id]: result.info }));
    callbacks.current.onStateChange?.(id, result.state);
  }, []);

  const refresh = useCallback(async (id: string) => {
    if (!id || !enabled.current) return;
    const revision = (requests.current[id] ?? 0) + 1;
    requests.current[id] = revision;
    try {
      const result = await window.electronAPI.webs.webapps.getPublishStatus(id);
      if (enabled.current && requests.current[id] === revision) accept(id, result);
    } catch (error) {
      if (enabled.current && requests.current[id] === revision) {
        setInfoById((current) => ({ ...current, [id]: null }));
        callbacks.current.onError(error instanceof Error ? error.message : String(error));
      }
    }
  }, [accept]);

  useEffect(() => {
    if (!active) return;
    enabled.current = true;
    for (const item of items) void refresh(item.id);
    const unsubscribe = window.electronAPI.webs.onChanged((event) => {
      if (event.reason === "tunnel-status-changed") {
        for (const item of items) void refresh(item.id);
      } else if (event.webappId && items.some((item) => item.id === event.webappId)) {
        void refresh(event.webappId);
      }
    });
    return () => {
      enabled.current = false;
      for (const id of Object.keys(requests.current)) requests.current[id]++;
      unsubscribe();
    };
  }, [active, items, refresh]);

  return { infoById, refresh, accept };
}
