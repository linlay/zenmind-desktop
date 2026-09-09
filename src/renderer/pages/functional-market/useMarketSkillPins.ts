import { useEffect, useRef, useState } from "react";
import type { MarketItem } from "@shared/contracts";
import { expandPinnedSkillKeys, pinnedMarketItems } from "./skillPinning";

const LEGACY_PINS = "market.skillPins";
const MIGRATED = "market.skillPins.orderMigrated";
function legacyPins(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(LEGACY_PINS) || "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch { return []; }
}

export function useMarketSkillPins(items: MarketItem[], loading: boolean) {
  const [order, setOrder] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const inFlight = useRef(false);
  const generation = useRef(0);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const pins = pinnedMarketItems(items, order);
  useEffect(() => {
    if (loading) return;
    let active = true;
    setFailed(false); setReady(false);
    const refresh = async () => {
      if (inFlight.current) return;
      const request = ++generation.current;
      try {
        const api = window.electronAPI.market;
        let value = await api.getSkillPins();
        if (!active || request !== generation.current) return;
        let migrated = false;
        try { migrated = localStorage.getItem(MIGRATED) === "1"; } catch { /* No legacy storage. */ }
        const old = legacyPins();
        if (!migrated && itemsRef.current.length > 0) {
          const keys = expandPinnedSkillKeys(itemsRef.current, old).reverse();
          for (const key of keys) {
            if (!active || request !== generation.current) return;
            if (!value.order.includes(key.toLowerCase())) value = await api.saveSkillPins({ key, pinned: true });
          }
          try { localStorage.setItem(MIGRATED, "1"); } catch { /* Per-key updates are idempotent. */ }
        }
        if (active && request === generation.current) { setOrder(value.order); setReady(true); setFailed(false); }
      } catch { if (active && request === generation.current) { setFailed(true); setReady(false); } }
    };
    void refresh();
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => { active = false; window.removeEventListener("focus", onFocus); };
  }, [loading, retry]);
  async function toggle(id: string) {
    if (!ready || inFlight.current) return;
    inFlight.current = true; generation.current++; setSaving(true); setFailed(false);
    const pinned = !pins.includes(id);
    const keys = expandPinnedSkillKeys(itemsRef.current, [id]);
    try {
      if (!keys.length) throw new Error("no_concrete_skills");
      // The official API inserts new pins first. Reverse package children so
      // their declared order is preserved; never replace another client's list.
      for (const key of pinned ? [...keys].reverse() : keys) {
        const value = await window.electronAPI.market.saveSkillPins({ key, pinned });
        setOrder(value.order);
      }
    } catch {
      setFailed(true);
      try { setOrder((await window.electronAPI.market.getSkillPins()).order); } catch { setReady(false); }
    } finally { inFlight.current = false; setSaving(false); }
  }
  return { pins, ready, saving, failed, toggle, retry: () => setRetry((value) => value + 1) };
}
