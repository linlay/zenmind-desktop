import { session, type Session, type WebContents, type WebPreferences } from "electron";

const partitions = new Map<string, { ownerId: number; url: string }>();
const prefix = "connector-auth:";
const authSessions = new WeakSet<Session>();

export function registerIsolatedAuthGuest(partition: string, ownerId: number, url: string) {
  partitions.set(partition, { ownerId, url });
  authSessions.add(session.fromPartition(partition));
  return () => partitions.delete(partition);
}

export function prepareIsolatedAuthGuest(ownerId: number | undefined, preferences: WebPreferences, params: { partition?: string; src?: string }) {
  if (!params.partition?.startsWith(prefix)) return undefined;
  const entry = partitions.get(params.partition);
  if (!entry || entry.ownerId !== ownerId || entry.url !== params.src) return false;
  delete preferences.preload;
  preferences.nodeIntegration = false;
  preferences.nodeIntegrationInSubFrames = false;
  preferences.contextIsolation = true;
  preferences.sandbox = true;
  preferences.webSecurity = true;
  preferences.webviewTag = false;
  preferences.allowRunningInsecureContent = false;
  return true;
}

export function configureIsolatedAuthGuest(value: unknown): boolean {
  const guest = value as WebContents;
  if (!authSessions.has(guest.session)) return false;
  // This isolated guest cannot open OS browsers, download files or obtain host permissions.
  guest.setWindowOpenHandler(() => ({ action: "deny" }));
  const guard = (event: { preventDefault(): void }, url: string) => {
    try {
      const parsed = new URL(url);
      if (!parsed.username && !parsed.password && (parsed.protocol === "https:" ||
          (parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)))) return;
    } catch { /* Deny malformed navigation. */ }
    event.preventDefault();
  };
  guest.on("will-navigate", guard);
  guest.on("will-redirect", guard);
  guest.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  guest.session.setPermissionCheckHandler(() => false);
  guest.session.on("will-download", event => event.preventDefault());
  return true;
}
