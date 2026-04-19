import { hasNativeAgentWebClientHost } from "@/shared/utils/host";

export const APP_UI_BASE = '/appagent';

export function isAppMode(
  pathname: string = typeof window !== 'undefined' ? window.location.pathname : '',
): boolean {
  if (hasNativeAgentWebClientHost()) {
    return true;
  }
  return pathname === APP_UI_BASE || pathname.startsWith(`${APP_UI_BASE}/`);
}
