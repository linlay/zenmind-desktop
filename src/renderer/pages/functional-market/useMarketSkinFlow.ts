import { useEffect, useRef, useState } from "react";
import { useAppearance } from "../../appearance/AppearanceProvider";
import { useI18n } from "../../i18n/useI18n";
import type { MarketItem } from "@shared/contracts";
import type { DesktopSkinId } from "../../../shared/desktop-appearance";
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
    const latest = useRef({ ready, saving: appearance.skinSaving, onChanged });
    latest.current = { ready, saving: appearance.skinSaving, onChanged };
    async function run(id: string, action: string, operation: () => Promise<boolean>, success: TranslationKey): Promise<boolean> {
        if (!mounted.current || active.current || latest.current.saving || !latest.current.ready)
            return false;
        active.current = true;
        setActivity({ id, action });
        setFailure(null);
        setNotice(null);
        let changed = false;
        try {
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
            const raw = error instanceof Error ? error.message : String(error);
            const key = `settings.appearance.${raw}` as TranslationKey;
            setFailure({ id, message: ["invalidPackage", "packageExists", "tooManySkins", "unsupportedPackageVersion", "packageTooLarge", "storageFailed", "runtimeOutdated"].includes(raw) ? t(key) : raw, retry: () => run(id, action, operation, success) });
            return false;
        }
        finally {
            active.current = false;
            if (mounted.current)
                setActivity(null);
        }
    }
    const install = (item: MarketItem) => run(item.id, "install", async () => { const result = await window.electronAPI.market.installSkin(item.id); if (!result.ok)
        throw Error(result.message); await appearance.refreshAppearanceFromCanonical(); return true; }, "market.skin.installed");
    const useSkin = (id: DesktopSkinId) => run(id, "use", async () => { await appearance.setSkinId(id); return true; }, "market.skin.applied");
    const remove = (id: DesktopSkinId) => run(id, "remove", async () => { await appearance.removeSkinPackage(id); return true; }, "market.skin.removed");
    const importSkin = () => run("import", "import", async () => Boolean(await appearance.importSkinPackage()), "market.skin.installed");
    return { appearance, ready, loading: appearance.skinLoadState === "loading", stateError: appearance.skinLoadState === "error" ? t("settings.appearance.loadFailed") : "", activity, busy: Boolean(activity) || appearance.skinSaving, busyId: activity?.id, error: failure?.message ?? "", errorItemId: failure?.id, notice, install, useSkin, remove, importSkin, retry: () => failure?.retry(), refresh: appearance.refreshAppearanceFromCanonical };
}
export type MarketSkinFlowRuntime = ReturnType<typeof useMarketSkinFlow>;
