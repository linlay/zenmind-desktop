import { useEffect, useRef, useState } from "react";
import { readMarketShareContext, type MarketShareTarget } from "../../../shared/market-share";

/** The page owns readiness and acknowledgement, outside the identity remount. */
export function useMarketShareReceiver(activationId: string, receive: (target: MarketShareTarget) => void) {
  const [instanceId] = useState(() => crypto.randomUUID());
  const lastIntent = useRef("");
  useEffect(() => {
    if (!activationId) return;
    let active = true;
    let generation: string | undefined;
    const api = window.electronAPI.market;
    const release = (value: string) => { void api.shareRelease({ activationId, generation: value }).catch(() => {}); };
    const unsubscribe = api.onShareReceive(delivery => {
      if (!active || delivery?.activationId !== activationId || delivery.instanceId !== instanceId ||
          typeof delivery.generation !== "string" || typeof delivery.target?.intentId !== "string" ||
          typeof delivery.target?.shareId !== "string") return;
      generation = delivery.generation;
      const context = readMarketShareContext(delivery.target.context);
      if (context && lastIntent.current !== delivery.target.intentId) {
        lastIntent.current = delivery.target.intentId;
        receive({ ...delivery.target, context });
      }
      void api.shareAck({ activationId, generation, intentId: delivery.target.intentId,
        status: context ? "received" : "invalid_context" }).catch(() => {});
    });
    // StrictMode cleans up its first effect before this single handshake starts.
    queueMicrotask(() => {
      if (!active) return;
      void api.shareReady({ activationId, instanceId }).then(reply => {
        if (!reply) return;
        if (!active) { release(reply.generation); return; }
        generation = reply.generation;
      }).catch(() => {});
    });
    return () => { active = false; unsubscribe(); if (generation) release(generation); };
  }, [activationId, instanceId, receive]);
}
