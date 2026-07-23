export const EMBEDDED_CDP_GATEWAY_HOST = "127.0.0.1";
export const EMBEDDED_CDP_GATEWAY_PORT = 11789;
export const EMBEDDED_CDP_GATEWAY_URL = `http://${EMBEDDED_CDP_GATEWAY_HOST}:${EMBEDDED_CDP_GATEWAY_PORT}`;

export type EmbeddedCdpSurfaceKind = "website" | "webapp" | "browser" | "service";
export type EmbeddedCdpSiteSurfaceKind = Extract<EmbeddedCdpSurfaceKind, "website" | "webapp">;

export type EmbeddedCdpSiteSurfaceRegistration = {
  registrationId: string;
  surfaceId: string;
  surfaceKind: EmbeddedCdpSiteSurfaceKind;
  label: string;
  url: string;
  currentUrl: string;
  title: string;
  webContentsId: number;
  active: boolean;
};

export type EmbeddedCdpSiteSurfaceRemoval = {
  registrationId: string;
  surfaceId: string;
};
