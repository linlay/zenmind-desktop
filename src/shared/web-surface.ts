import { stableSurfaceHash } from "./surface-identity";

/** A Container owns tabs; a Surface identifies exactly one live page within it.
 * Navigation preserves identity. Closing/reopening a container rotates registrationId.
 * The guest id is deliberately excluded: queued commands separately pin the guest.
 */
export function createWebSurfaceId(containerId: string, registrationId: string, tabId: string) {
  return `page:${stableSurfaceHash(JSON.stringify([containerId, registrationId, tabId]))}`;
}

export type WebSurface = {
  surfaceId: string;
  containerId: string;
  title: string;
  url: string;
  active: boolean;
  isLoading: boolean;
};

export type WebContainer = {
  containerId: string;
  label: string;
  kind: "website" | "webapp" | "browser" | "service" | "chat-work-panel";
  active: boolean;
  surfaceIds: string[];
};
