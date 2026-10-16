import { type DesktopActionCallRequest } from "../../../shared/desktop-actions";

export function normalizePermissionMode(value: unknown) {
  return value === "full_access" || value === "default"
    ? value
    : "";
}

// Only the top-level field counts: action args can come from the model, which must not lift its own permission.
export function readRequestPermissionMode(request: DesktopActionCallRequest) {
  return normalizePermissionMode(request.permissionMode) || "default";
}
