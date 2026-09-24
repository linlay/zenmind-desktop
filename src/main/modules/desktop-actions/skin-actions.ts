import path from "node:path";
import { DESKTOP_SKIN_IDS, isBuiltinDesktopSkinId, isDesktopSkinId, isInstalledDesktopSkinId, type DesktopSkinView } from "../../../shared/desktop-appearance";
import type { DesktopSkinState, DesktopSkinSummary } from "../../../shared/desktop-skin-actions";
import { SkinPackageError } from "../../../shared/desktop-skin-package";
import type { DesktopActionBridgeOptions, DesktopActionInvocationContext } from "./action-contracts";
import type { DesktopActionCallRequest } from "../../../shared/desktop-actions";
import { fail, ok } from "./action-values";
import { t } from "../../support/i18n/main-i18n";

export function isDesktopSkinArchivePath(value: unknown, platform: NodeJS.Platform): value is string {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) return false;
  if (platform === "win32") {
    // Fully qualified drive paths only; reject drive-relative, UNC/network and device paths.
    return /^[a-zA-Z]:[\\/]/.test(value) && !value.slice(2).includes(":") && path.win32.isAbsolute(value) && path.win32.extname(value).toLowerCase() === ".zip";
  }
  if (platform === "darwin") return path.posix.isAbsolute(value) && !value.startsWith("//") && path.posix.extname(value).toLowerCase() === ".zip";
  return path.posix.isAbsolute(value) && !value.startsWith("//") && path.posix.extname(value).toLowerCase() === ".zip";
}

function state(view: DesktopSkinView): DesktopSkinState {
  const available = isBuiltinDesktopSkinId(view.skinId) || Boolean(view.installedSkin);
  return { skinId: view.skinId, activeSkinId: available ? view.skinId : "default", available,
    customBackground: { configured: Boolean(view.background), available: Boolean(view.background && view.backgroundDataUrl) } };
}

function summaries(view: DesktopSkinView): DesktopSkinSummary[] {
  const names = { default: "settings.appearance.skinDefault", mist: "settings.appearance.skinMist", ocean: "settings.appearance.skinOcean", violet: "settings.appearance.skinViolet" } as const;
  return [
    ...DESKTOP_SKIN_IDS.map((skinId): DesktopSkinSummary => ({ skinId, name: t(names[skinId]), source: "builtin", available: true })),
    ...(view.installedSkins ?? []).map((item): DesktopSkinSummary => ({ skinId: item.id, name: item.name, version: item.version, source: "installed", available: true }))
  ];
}

export async function executeSkinAction(options: DesktopActionBridgeOptions, request: DesktopActionCallRequest, invocation: DesktopActionInvocationContext) {
  const action = request.action;
  if (invocation.kind !== "desktop" && invocation.kind !== "agentPlatform") return fail(action, "forbidden", "Skin actions require an authorized Desktop or Agent Platform caller.");
  const raw = request.args;
  if (raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw))) return fail(action, "invalid_args", "args must be an object.");
  const args = raw ?? {};
  const allowed = action === "desktop.skin.import" ? ["filePath"] : action === "desktop.skin.set" ? ["skinId", "keepBackground"] : action === "desktop.skin.remove" ? ["skinId"] : [];
  if (Object.keys(args).some(key => !allowed.includes(key))) return fail(action, "invalid_args", "Unexpected skin action argument.");
  if (action === "desktop.skin.import" && !isDesktopSkinArchivePath(args.filePath, options.platform ?? process.platform)) return fail(action, "invalid_args", "filePath must be an absolute local ZIP path on the Desktop host.");
  if ((action === "desktop.skin.set" || action === "desktop.skin.remove") && !isDesktopSkinId(args.skinId)) return fail(action, "invalid_args", "skinId must be a Desktop skin identifier.");
  if (action === "desktop.skin.set" && args.keepBackground !== undefined && typeof args.keepBackground !== "boolean") return fail(action, "invalid_args", "keepBackground must be boolean.");
  if (action === "desktop.skin.remove" && !isInstalledDesktopSkinId(args.skinId)) return fail(action, "invalid_args", "Built-in skins cannot be removed.");
  const runtime = options.appearanceRuntime;
  if (!runtime) return fail(action, "unavailable", "Desktop appearance runtime is unavailable.");
  try {
    return await runtime.run(async store => {
      if (action === "desktop.skin.get") return ok(action, state(store.read()));
      if (action === "desktop.skin.list") return ok(action, { skins: summaries(store.read()) });
      if (action === "desktop.skin.import") {
        const imported = await store.importPackage(args.filePath as string);
        const summary = summaries(imported.settings).find(item => item.skinId === imported.importedSkinId);
        return summary ? ok(action, summary) : fail(action, "invalid_action_result", "The imported skin is unavailable.");
      }
      if (!summaries(store.read()).some(item => item.skinId === args.skinId)) return fail(action, "skin_not_found", "The selected skin is unavailable.", { category: "not_found", executionState: "not_started" });
      if (action === "desktop.skin.set") return ok(action, state(store.setSkin(args.skinId, { keepBackground: args.keepBackground as boolean | undefined })));
      const next = state(store.removePackage(args.skinId));
      return ok(action, { skinId: args.skinId, activeSkinId: next.activeSkinId });
    }, result => result.ok && action !== "desktop.skin.get" && action !== "desktop.skin.list");
  } catch (error) {
    if (error instanceof SkinPackageError) return fail(action, error.code, `Skin package operation failed: ${error.code}.`, { category: error.code === "packageExists" ? "conflict" : "validation", stage: "package", executionState: "not_started" });
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return fail(action, "file_not_found", "The skin ZIP file does not exist on the Desktop host.", { category: "not_found", executionState: "not_started" });
    if (code === "EACCES" || code === "EPERM") return fail(action, "file_access_denied", "Desktop cannot access the skin file or storage.", { category: "authorization" });
    // Filesystem exceptions may contain host paths; never forward their raw messages.
    return fail(action, "storageFailed", "Desktop could not read or save the skin package.");
  }
}
