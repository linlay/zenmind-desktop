import { useEffect, useRef, useState } from "react";
import { useAppearance } from "../../appearance/AppearanceProvider";
import { useI18n } from "../../i18n/useI18n";
import type { MarketItem } from "@shared/contracts";
import { isInstalledDesktopSkinId, type DesktopSkinId } from "../../../shared/desktop-appearance";
import type { TranslationKey } from "../../../shared/i18n";
export function useMarketSkinFlow(onChanged?: () => unknown) {
    const appearance = useAppearance(), { t } = useI18n();
    const [activity, setActivity] = useState<{
        id: string;
        action: string;
    } | null>(null);
    const [failure, setFailure] = useState<{
        id: string;
        message: string;
        retry: () => Promise<boolean>;
    } | null>(null);
    const [notice, setNotice] = useState<{
        text: TranslationKey;
        revision: number;
    } | null>(null);
    const active = useRef(false), revision = useRef(0), mounted = useRef(true);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const ready = appearance.skinLoadState === "ready";
    const latest = useRef({ onChanged });
    latest.current = { onChanged };
    function errorMessage(error: unknown) {
        const raw = error instanceof Error ? error.message : String(error);
        const key = `settings.appearance.${raw}` as TranslationKey;
        return ["invalidPackage", "packageExists", "tooManySkins", "unsupportedPackageVersion", "packageTooLarge", "storageFailed", "runtimeOutdated"].includes(raw) ? t(key) : raw;
    }
    async function run(id: string, action: string, operation: () => Promise<boolean>, success: TranslationKey, retrying = false): Promise<boolean> {
        const snapshot = appearance.getAppearanceSnapshot();
        if (!mounted.current || active.current || snapshot.skinSaving || (!retrying && snapshot.skinLoadState !== "ready"))
            return false;
        active.current = true;
        setActivity({ id, action });
        setFailure(null);
        setNotice(null);
        let changed = false;
        try {
            if (snapshot.skinLoadState !== "ready") {
                await appearance.refreshAppearanceFromCanonical();
                if (!mounted.current) return false;
                if (appearance.getAppearanceSnapshot().skinLoadState !== "ready") throw Error(t("market.skin.stateUnavailable"));
            }
            changed = await operation();
            if (changed && mounted.current) {
                setNotice({ text: success, revision: ++revision.current });
                if (action !== "use")
                    void Promise.resolve(latest.current.onChanged?.()).catch(() => { });
            }
            return changed;
        }
        catch (error) {
            if (!mounted.current)
                return false;
            setFailure({ id, message: errorMessage(error), retry: () => run(id, action, operation, success, true) });
            return false;
        }
        finally {
            active.current = false;
            if (mounted.current)
                setActivity(null);
        }
    }
    function installAndApply(id: string, action: "install" | "import", installPackage: () => Promise<{ skinId: unknown } | null>) {
        // Keep the committed package across retries; a failed application must
        // not reopen the picker or attempt to install the same version again.
        let installed: { skinId: unknown } | null = null;
        return run(id, action, async () => {
            if (!installed) installed = await installPackage();
            if (!installed || !mounted.current) return false;
            try {
                await appearance.refreshAppearanceFromCanonical();
                if (!mounted.current) return false;
                const snapshot = appearance.getAppearanceSnapshot(), skinId = installed.skinId;
                if (snapshot.skinLoadState !== "ready") throw Error(t("market.skin.stateUnavailable"));
                if (!isInstalledDesktopSkinId(skinId) || !snapshot.skinSettings.installedSkins?.some(skin => skin.id === skinId))
                    throw Error(t("market.skin.applyUnavailable"));
                await appearance.setSkinId(skinId);
                if (!mounted.current) return false;
                const applied = appearance.getAppearanceSnapshot();
                if (applied.skinSettings.skinId !== skinId || applied.skin.id !== skinId)
                    throw Error(t("market.skin.applyUnavailable"));
                return true;
            } catch (error) {
                throw Error(t("market.skin.applyFailed", { message: errorMessage(error) }));
            }
        }, "market.skin.installedAndApplied");
    }
    const install = (item: MarketItem) => installAndApply(item.id, "install", async () => {
        const result = await window.electronAPI.market.installSkin(item.id);
        if (result.canceled) return null;
        if (!result.ok) throw Error(result.message);
        return { skinId: result.skinId };
    });
    const useSkin = (id: DesktopSkinId) => run(id, "use", async () => { await appearance.setSkinId(id); return true; }, "market.skin.applied");
    const remove = (id: DesktopSkinId) => run(id, "remove", async () => { await appearance.removeSkinPackage(id); return true; }, "market.skin.removed");
    const importSkin = () => installAndApply("import", "import", async () => {
        const skinId = await appearance.importSkinPackage();
        return skinId ? { skinId } : null;
    });
    return { appearance, ready, loading: appearance.skinLoadState === "loading", stateError: appearance.skinLoadState === "error" ? t("settings.appearance.loadFailed") : "", activity, busy: Boolean(activity) || appearance.skinSaving, busyId: activity?.id, error: failure?.message ?? "", errorItemId: failure?.id, notice, install, useSkin, remove, importSkin, retry: () => failure?.retry(), refresh: appearance.refreshAppearanceFromCanonical };
}
export type MarketSkinFlowRuntime = ReturnType<typeof useMarketSkinFlow>;
