import { validateTrust, type UpdateTrust } from "./signing";
declare const __DESKTOP_UPDATE_TRUST__: UpdateTrust;
// A development build without explicitly embedded public keys fails closed.
export const UPDATE_TRUST = validateTrust(typeof __DESKTOP_UPDATE_TRUST__ === "undefined"
  ? { keys: [] } : __DESKTOP_UPDATE_TRUST__);
