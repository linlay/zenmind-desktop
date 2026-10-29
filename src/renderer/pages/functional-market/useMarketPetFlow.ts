import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopPetState, MarketItem } from "@shared/contracts";
import type { TranslationKey } from "../../../shared/i18n";
import { useI18n } from "../../i18n/useI18n";

type PetAction = "install" | "use" | "remove" | "import";
export function useMarketPetFlow(onChanged?: () => unknown) {
  const { t } = useI18n();
  const [petState, setPetState] = useState<DesktopPetState | null>(null);
  const [loading, setLoading] = useState(true);
  const [stateError, setStateError] = useState("");
  const [failure, setFailure] = useState<{ id: string; action: PetAction; message: string; retry: () => Promise<boolean> } | null>(null);
  const [notice, setNotice] = useState<{ text: TranslationKey; revision: number } | null>(null);
  const [activity, setActivity] = useState<{ id: string; action: PetAction } | null>(null);
  const mounted = useRef(true), mutation = useRef(false), revision = useRef(0), notices = useRef(0);
  const callback = useRef(onChanged); callback.current = onChanged;
  const snapshot = useRef({ petState, loading, stateError }); snapshot.current = { petState, loading, stateError };
  const refresh = useCallback(async () => {
    if (!mounted.current) return;
    const request = ++revision.current;
    try {
      const state = await window.electronAPI.desktopPet.getState();
      if (mounted.current && request === revision.current) { setPetState(state); setStateError(""); }
    } catch (reason) {
      if (mounted.current && request === revision.current) setStateError(reason instanceof Error ? reason.message : String(reason));
    } finally { if (mounted.current && request === revision.current) setLoading(false); }
  }, []);
  useEffect(() => {
    mounted.current = true; void refresh();
    const unsubscribe = window.electronAPI.desktopPet.onStateChanged(state => {
      if (mounted.current) { revision.current++; setPetState(state); setStateError(""); setLoading(false); }
    });
    const visible = () => { if (document.visibilityState === "visible" && !mutation.current) void refresh(); };
    window.addEventListener("focus", visible); document.addEventListener("visibilitychange", visible);
    return () => { mounted.current = false; revision.current++; unsubscribe(); window.removeEventListener("focus", visible); document.removeEventListener("visibilitychange", visible); };
  }, [refresh]);
  async function mutate(id: string, action: PetAction, operation: () => Promise<boolean>, success: TranslationKey): Promise<boolean> {
    if (!mounted.current || mutation.current) return false;
    if ((action === "install" || action === "use") && (!snapshot.current.petState || snapshot.current.loading || snapshot.current.stateError)) return false;
    mutation.current = true; setActivity({ id, action }); setFailure(null); setNotice(null);
    let changed = false;
    try {
      changed = await operation();
      if (!changed || !mounted.current) return changed;
      await refresh();
      if (mounted.current) setNotice({ text: success, revision: ++notices.current });
      return true;
    } catch (reason) {
      if (mounted.current) setFailure({ id, action, message: reason instanceof Error ? reason.message : String(reason), retry: () => mutate(id, action, operation, success) });
      return false;
    } finally {
      mutation.current = false;
      if (mounted.current) {
        setActivity(null);
        // Switching appearance changes only local pet state. Catalog mutations
        // return to StorefrontMarket's existing refresh and identity boundary.
        if (changed && action !== "use") void Promise.resolve(callback.current?.()).catch(() => {});
      }
    }
  }
  const usePet = (appearanceId: string) => mutate(appearanceId, "use", async () => {
    const state = await window.electronAPI.desktopPet.saveSettings({ appearanceId });
    if (state.appearanceId !== appearanceId) throw new Error(t("settings.desktopPet.noticeAppearanceFailed"));
    if (mounted.current) setPetState(state);
    return true;
  }, "market.pet.switched");
  const install = (item: MarketItem) => mutate(item.id, "install", async () => {
    const result = await window.electronAPI.market.installPet(item.id);
    if (!result.ok) throw new Error(result.message);
    return true;
  }, "market.pet.readyToUse");
  const remove = (appearanceId: string) => mutate(appearanceId, "remove", async () => {
    const result = await window.electronAPI.desktopPet.removePackage(appearanceId);
    if (!result.ok) throw new Error(t("settings.desktopPet.remove.failed"));
    if (mounted.current) setPetState(result.state);
    return true;
  }, "settings.desktopPet.remove.success");
  const importPet = () => mutate("import", "import", async () => {
    const result = await window.electronAPI.desktopPet.importPackage();
    if (!result.ok) throw new Error(t(`settings.desktopPet.import.${result.error}`));
    if (result.cancelled) return false;
    if (mounted.current) setPetState(result.state);
    return true;
  }, "market.pet.readyToUse");
  return { petState, loading, stateError, error: failure?.message ?? "", errorItemId: failure?.id, errorAction: failure?.action, notice, activity, busy: Boolean(activity), busyId: activity?.id ?? "",
    refresh, usePet, install, remove, importPet, retry: () => failure?.retry(), dismissError: () => setFailure(null) };
}
export type MarketPetFlowRuntime = ReturnType<typeof useMarketPetFlow>;
